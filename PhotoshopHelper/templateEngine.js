/**
 * Create a syntax error that identifies both the template location and the
 * expression offset. Provider configuration is edited by humans, so reporting
 * the exact conditional key is considerably more useful than a generic parser
 * failure from deep inside request construction.
 *
 * @param {string} message - Human-readable parser failure.
 * @param {string} expression - Conditional expression being parsed.
 * @param {string} templatePath - JSON-like path of the template key.
 * @param {number} offset - Zero-based character offset inside the expression.
 * @returns {SyntaxError} Structured condition syntax error.
 */
function createConditionSyntaxError(message, expression, templatePath, offset) {
    const error = new SyntaxError(
        `Invalid template condition at ${templatePath}, offset ${offset}, `
        + `in ${JSON.stringify(expression)}: ${message}`
    );
    error.code = 'TEMPLATE_CONDITION_SYNTAX_ERROR';
    return error;
}

/**
 * Tokenize the intentionally small conditional-expression language.
 *
 * The tokenizer accepts only literals, context identifiers, boolean operators,
 * equality operators, and grouping parentheses. It deliberately rejects member
 * access, calls, arithmetic, arrays, assignments, and every other JavaScript
 * construct so provider configuration can never become executable code.
 *
 * @param {string} expression - Expression extracted from a conditional key.
 * @param {string} templatePath - Location used in syntax errors.
 * @returns {Array<{type: string, value: *, offset: number}>} Token sequence.
 */
function tokenizeCondition(expression, templatePath) {
    const tokens = [];
    let index = 0;

    while (index < expression.length) {
        const character = expression[index];

        if (/\s/.test(character)) {
            index += 1;
            continue;
        }

        const twoCharacters = expression.slice(index, index + 2);
        if (['&&', '||', '==', '!='].includes(twoCharacters)) {
            tokens.push({ type: 'operator', value: twoCharacters, offset: index });
            index += 2;
            continue;
        }

        if (character === '!') {
            tokens.push({ type: 'operator', value: character, offset: index });
            index += 1;
            continue;
        }

        if (character === '(' || character === ')') {
            tokens.push({ type: 'parenthesis', value: character, offset: index });
            index += 1;
            continue;
        }

        if (character === '\'' || character === '"') {
            const quote = character;
            const startOffset = index;
            let value = '';
            let terminated = false;
            index += 1;

            while (index < expression.length) {
                const stringCharacter = expression[index];

                if (stringCharacter === quote) {
                    terminated = true;
                    index += 1;
                    break;
                }

                if (stringCharacter === '\n' || stringCharacter === '\r') {
                    throw createConditionSyntaxError(
                        'String literals cannot contain an unescaped line break.',
                        expression,
                        templatePath,
                        index
                    );
                }

                if (stringCharacter !== '\\') {
                    value += stringCharacter;
                    index += 1;
                    continue;
                }

                const escapeOffset = index;
                index += 1;
                if (index >= expression.length) {
                    throw createConditionSyntaxError(
                        'Unterminated escape sequence in string literal.',
                        expression,
                        templatePath,
                        escapeOffset
                    );
                }

                const escapedCharacter = expression[index];
                const simpleEscapes = {
                    '\\': '\\',
                    '\'': '\'',
                    '"': '"',
                    n: '\n',
                    r: '\r',
                    t: '\t',
                    b: '\b',
                    f: '\f'
                };

                if (Object.prototype.hasOwnProperty.call(simpleEscapes, escapedCharacter)) {
                    value += simpleEscapes[escapedCharacter];
                    index += 1;
                    continue;
                }

                if (escapedCharacter === 'u') {
                    const hex = expression.slice(index + 1, index + 5);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
                        throw createConditionSyntaxError(
                            'Unicode escapes must contain exactly four hexadecimal digits.',
                            expression,
                            templatePath,
                            escapeOffset
                        );
                    }
                    value += String.fromCharCode(Number.parseInt(hex, 16));
                    index += 5;
                    continue;
                }

                throw createConditionSyntaxError(
                    `Unsupported escape sequence "\\${escapedCharacter}".`,
                    expression,
                    templatePath,
                    escapeOffset
                );
            }

            if (!terminated) {
                throw createConditionSyntaxError(
                    'Unterminated string literal.',
                    expression,
                    templatePath,
                    startOffset
                );
            }

            tokens.push({ type: 'literal', value, offset: startOffset });
            continue;
        }

        const remainingExpression = expression.slice(index);
        const numberMatch = remainingExpression.match(
            /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/
        );
        if (numberMatch) {
            const rawNumber = numberMatch[0];
            const numericValue = Number(rawNumber);
            if (!Number.isFinite(numericValue)) {
                throw createConditionSyntaxError(
                    'Numeric literals must be finite.',
                    expression,
                    templatePath,
                    index
                );
            }
            tokens.push({ type: 'literal', value: numericValue, offset: index });
            index += rawNumber.length;
            continue;
        }

        const identifierMatch = remainingExpression.match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (identifierMatch) {
            const identifier = identifierMatch[0];
            if (identifier === 'true') {
                tokens.push({ type: 'literal', value: true, offset: index });
            } else if (identifier === 'false') {
                tokens.push({ type: 'literal', value: false, offset: index });
            } else if (identifier === 'null') {
                tokens.push({ type: 'literal', value: null, offset: index });
            } else {
                tokens.push({ type: 'identifier', value: identifier, offset: index });
            }
            index += identifier.length;
            continue;
        }

        throw createConditionSyntaxError(
            `Unexpected character ${JSON.stringify(character)}.`,
            expression,
            templatePath,
            index
        );
    }

    tokens.push({ type: 'eof', value: null, offset: expression.length });
    return tokens;
}

/**
 * Recursive-descent evaluator for conditional key expressions.
 *
 * Parsing and evaluation are combined because the language is pure: it has no
 * calls, assignments, or property access. Operator precedence is encoded by the
 * parse method hierarchy: !, equality, &&, then ||.
 */
class ConditionParser {
    /**
     * @param {Array<{type: string, value: *, offset: number}>} tokens - Tokenized expression.
     * @param {string} expression - Original expression for diagnostics.
     * @param {string} templatePath - Template path for diagnostics.
     * @param {object} context - Placeholder context used by identifiers.
     */
    constructor(tokens, expression, templatePath, context) {
        this.tokens = tokens;
        this.expression = expression;
        this.templatePath = templatePath;
        this.context = context;
        this.position = 0;
    }

    /** @returns {{type: string, value: *, offset: number}} Current token. */
    current() {
        return this.tokens[this.position];
    }

    /**
     * Consume a token when it matches the supplied type and optional value.
     *
     * @param {string} type - Required token type.
     * @param {*} [value] - Optional token value.
     * @returns {boolean} Whether a token was consumed.
     */
    match(type, value) {
        const token = this.current();
        if (token.type !== type || (value !== undefined && token.value !== value)) {
            return false;
        }
        this.position += 1;
        return true;
    }

    /**
     * Throw a syntax error at the current token.
     *
     * @param {string} message - Failure explanation.
     * @returns {never}
     */
    fail(message) {
        throw createConditionSyntaxError(
            message,
            this.expression,
            this.templatePath,
            this.current().offset
        );
    }

    /** @returns {boolean} Fully evaluated expression result. */
    parse() {
        const value = this.parseOr();
        if (this.current().type !== 'eof') {
            this.fail(`Unexpected token ${JSON.stringify(this.current().value)}.`);
        }
        return Boolean(value);
    }

    /** @returns {*} Value after applying logical OR operations. */
    parseOr() {
        let value = this.parseAnd();
        while (this.match('operator', '||')) {
            const rightValue = this.parseAnd();
            value = Boolean(value) || Boolean(rightValue);
        }
        return value;
    }

    /** @returns {*} Value after applying logical AND operations. */
    parseAnd() {
        let value = this.parseEquality();
        while (this.match('operator', '&&')) {
            const rightValue = this.parseEquality();
            value = Boolean(value) && Boolean(rightValue);
        }
        return value;
    }

    /**
     * Parse at most one equality comparison. Chained comparisons are rejected
     * because their JavaScript meaning is surprising in configuration files.
     *
     * @returns {*} Literal/context value or strict comparison result.
     */
    parseEquality() {
        const leftValue = this.parseUnary();
        const operator = this.current();

        if (operator.type !== 'operator' || !['==', '!='].includes(operator.value)) {
            return leftValue;
        }

        this.position += 1;
        const rightValue = this.parseUnary();
        if (
            this.current().type === 'operator'
            && ['==', '!='].includes(this.current().value)
        ) {
            this.fail('Chained equality comparisons are not supported.');
        }

        // Both equality spellings intentionally use strict JavaScript semantics.
        return operator.value === '=='
            ? leftValue === rightValue
            : leftValue !== rightValue;
    }

    /** @returns {*} Value after applying any leading logical negation. */
    parseUnary() {
        if (this.match('operator', '!')) {
            return !Boolean(this.parseUnary());
        }
        return this.parsePrimary();
    }

    /** @returns {*} Identifier, literal, or grouped expression value. */
    parsePrimary() {
        const token = this.current();

        if (token.type === 'literal') {
            this.position += 1;
            return token.value;
        }

        if (token.type === 'identifier') {
            this.position += 1;
            return Object.prototype.hasOwnProperty.call(this.context, token.value)
                ? this.context[token.value]
                : undefined;
        }

        if (this.match('parenthesis', '(')) {
            const value = this.parseOr();
            if (!this.match('parenthesis', ')')) {
                this.fail('Expected a closing parenthesis.');
            }
            return value;
        }

        if (token.type === 'eof') {
            this.fail('Expected a literal, context identifier, or parenthesized expression.');
        }
        this.fail(`Unexpected token ${JSON.stringify(token.value)}.`);
    }
}

/**
 * Evaluate one conditional-key expression against a template context.
 *
 * @param {string} expression - Expression without the surrounding {{? ... }}.
 * @param {object} context - Placeholder context.
 * @param {string} templatePath - Template location for errors.
 * @returns {boolean} Whether the conditional key should be included.
 */
function evaluateCondition(expression, context, templatePath) {
    if (expression.trim() === '') {
        throw createConditionSyntaxError(
            'The condition expression cannot be empty.',
            expression,
            templatePath,
            0
        );
    }

    const tokens = tokenizeCondition(expression, templatePath);
    return new ConditionParser(tokens, expression, templatePath, context).parse();
}

/**
 * Append an object key to a JSON-like template path.
 *
 * @param {string} parentPath - Existing template path.
 * @param {string} key - Object key to append.
 * @returns {string} Path suitable for diagnostics.
 */
function appendObjectPath(parentPath, key) {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        ? `${parentPath}.${key}`
        : `${parentPath}[${JSON.stringify(key)}]`;
}

/**
 * Find the closing delimiter of a conditional prefix without mistaking a
 * delimiter-shaped sequence inside a quoted string for the end of the prefix.
 * Escape validation remains the tokeniser's responsibility; this scan only
 * tracks enough quote state to identify the structurally correct `}}` pair.
 *
 * @param {string} key - Raw conditional template key.
 * @returns {number} Index of the first closing brace, or -1 when none exists.
 */
function findConditionalClosingIndex(key) {
    let activeQuote = null;
    let escaped = false;

    for (let index = 3; index < key.length - 1; index += 1) {
        const character = key[index];

        if (activeQuote !== null) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (character === '\\') {
                escaped = true;
                continue;
            }

            if (character === activeQuote) {
                activeQuote = null;
            }
            continue;
        }

        if (character === '\'' || character === '"') {
            activeQuote = character;
            continue;
        }

        if (character === '}' && key[index + 1] === '}') {
            return index;
        }
    }

    return -1;
}

/**
 * Parse a conditional object-key prefix.
 *
 * @param {string} key - Raw template object key.
 * @param {string} parentPath - Parent object path.
 * @returns {{expression: string, outputKey: string, sourcePath: string}|null} Parsed prefix.
 */
function parseConditionalKey(key, parentPath) {
    if (!key.startsWith('{{?')) {
        return null;
    }

    const sourcePath = appendObjectPath(parentPath, key);
    const closingIndex = findConditionalClosingIndex(key);
    if (closingIndex === -1) {
        throw createConditionSyntaxError(
            'The conditional key is missing its closing "}}" delimiter.',
            key.slice(3),
            sourcePath,
            Math.max(0, key.length - 3)
        );
    }

    const expression = key.slice(3, closingIndex).trim();
    const outputKey = key.slice(closingIndex + 2);
    if (outputKey === '') {
        throw createConditionSyntaxError(
            'A conditional prefix must be followed by an output key.',
            expression,
            sourcePath,
            expression.length
        );
    }

    return { expression, outputKey, sourcePath };
}

/**
 * Resolve placeholders and conditional keys recursively.
 *
 * @param {*} template - Current template node.
 * @param {object} context - Placeholder and condition values.
 * @param {string} templatePath - JSON-like path for diagnostics.
 * @returns {*} Fully resolved template node.
 */
function resolveTemplateNode(template, context, templatePath) {
    if (typeof template === 'string' && template.match(/^{{\??[^}]+}}$/)) {
        // Preserve non-string values when the entire string is one placeholder.
        // The optional question mark retains compatibility with legacy templates.
        const match = template.match(/^{{\??([^}]+)}}$/);
        const key = match[1];

        if (key.startsWith('env:')) {
            const envVar = key.replace('env:', '');
            return process.env[envVar] || '';
        }
        if (context[key] !== undefined && typeof context[key] !== 'string') {
            return context[key];
        }
    }

    if (typeof template === 'string') {
        return template.replace(/{{([^}]+)}}/g, (match, key) => {
            if (key.startsWith('env:')) {
                const envVar = key.replace('env:', '');
                return process.env[envVar] || '';
            }
            return context[key] !== undefined ? context[key] : match;
        });
    }

    if (Array.isArray(template)) {
        const resolved = template.map((item, index) => (
            resolveTemplateNode(item, context, `${templatePath}[${index}]`)
        ));

        // Array-valued placeholders are spread into the parent array. Empty
        // optional values are omitted to match the historical resolver behavior.
        return resolved.reduce((result, item) => {
            if (Array.isArray(item)) result.push(...item);
            else if (item !== null && item !== undefined && item !== '') result.push(item);
            return result;
        }, []);
    }

    if (typeof template === 'object' && template !== null) {
        const result = {};
        const outputKeySources = new Map();

        for (const [templateKey, value] of Object.entries(template)) {
            const conditionalKey = parseConditionalKey(templateKey, templatePath);
            const outputKey = conditionalKey?.outputKey ?? templateKey;

            if (
                conditionalKey
                && !evaluateCondition(
                    conditionalKey.expression,
                    context,
                    conditionalKey.sourcePath
                )
            ) {
                continue;
            }

            if (outputKeySources.has(outputKey)) {
                const previousTemplateKey = outputKeySources.get(outputKey);
                const outputPath = appendObjectPath(templatePath, outputKey);
                const error = new Error(
                    `Template key collision at ${outputPath}: both `
                    + `${JSON.stringify(previousTemplateKey)} and `
                    + `${JSON.stringify(templateKey)} matched.`
                );
                error.code = 'TEMPLATE_KEY_COLLISION';
                throw error;
            }

            outputKeySources.set(outputKey, templateKey);
            const resolvedValue = resolveTemplateNode(
                value,
                context,
                appendObjectPath(templatePath, outputKey)
            );

            // defineProperty avoids the special __proto__ setter while retaining a
            // normal plain object for downstream request and JSON serialization code.
            Object.defineProperty(result, outputKey, {
                value: resolvedValue,
                enumerable: true,
                configurable: true,
                writable: true
            });
        }
        return result;
    }

    return template;
}

/**
 * Resolve a provider template against its request context.
 *
 * This is the template engine's only production export. Parser and evaluator
 * details remain private; tests exercise them through the same public operation
 * used by request generation.
 *
 * @param {*} template - JSON-compatible template value.
 * @param {object} [context={}] - Placeholder and condition values.
 * @returns {*} Resolved template value.
 */
function resolveTemplate(template, context = {}) {
    const safeContext = context && typeof context === 'object' ? context : {};
    return resolveTemplateNode(template, safeContext, '$');
}

module.exports = { resolveTemplate };
