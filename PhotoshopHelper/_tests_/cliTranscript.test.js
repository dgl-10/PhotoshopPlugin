'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTranscript } = require('../agent/cli-transcript');
const { buildArgs, parseOutput } = require('../agent/cli-runner');

// The samples below are shortened copies of what the real CLIs printed on a prompt that
// asked for one `echo hi` command.
const CODEX_EVENTS = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I am about to run echo hi."}}',
    '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"cmd /c echo hi","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"reasoning","text":"**Retrying shell command**"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"cmd /c echo hi","aggregated_output":"hi\\r\\n","exit_code":0,"status":"completed"}}',
    '{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"It printed hi."}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":3}}'
].join('\n');

const GROK_EVENTS = [
    '{"type":"available_commands","tools":["run_terminal_command"]}',
    '{"type":"thought","data":"I will state"}',
    '{"type":"thought","data":" my plan."}',
    '{"type":"text","data":"I will run "}',
    '{"type":"text","data":"echo hi."}',
    '{"type":"tool_call","toolCallId":"c1","title":"run_terminal_command","status":"pending","rawInput":{"command":"echo hi"}}',
    '{"type":"tool_call_update","toolCallId":"c1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"hi\\r\\n"}}]}',
    '{"type":"text","data":"It printed hi."}',
    '{"type":"usage","usage":{"input_tokens":1}}',
    '{"type":"end","stopReason":"end_turn","sessionId":"g-1"}'
].join('\n');

const AGY_EVENTS = [
    '{"event":"init","conversation_id":"a-1","init":{"cwd":"x"}}',
    '{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}',
    '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"I am about "}}',
    '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"to run echo hi."}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}',
    '{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command"}}',
    '{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"It printed hi."}}',
    '{"event":"result","result":{"conversation_id":"a-1","status":"SUCCESS","response":"It printed hi.\\n"}}'
].join('\n');

/**
 * @param {string} parse - Parse kind.
 * @param {string} stdout - Output to feed in pieces that cut lines in half.
 * @param {string} [stderr] - Error output.
 * @returns {{text: string, pieces: string[]}}
 */
function runTranscript(parse, stdout, stderr = '') {
    const pieces = [];
    const transcript = createTranscript(parse, { onAppend: piece => pieces.push(piece) });
    for (let index = 0; index < stdout.length; index += 37) {
        transcript.push('stdout', stdout.slice(index, index + 37));
    }
    transcript.finish(stdout, stderr);
    return { text: transcript.getText(), pieces };
}

test('Codex events become thoughts, remarks, commands and their output', () => {
    const { text, pieces } = runTranscript('codex', CODEX_EVENTS);

    assert.equal(text, [
        '[agent] I am about to run echo hi.',
        '[run] cmd /c echo hi',
        '[thinking] **Retrying shell command**',
        '[output, exit 0] hi',
        '[agent] It printed hi.',
        '[done] {"input_tokens":10,"output_tokens":3}',
        ''
    ].join('\n'));
    assert.equal(pieces.join(''), text, 'a window sees exactly what the caller gets');
});

test('Grok events join thought and answer pieces and show the tool call', () => {
    const { text } = runTranscript('grok-stream', GROK_EVENTS);

    assert.equal(text, [
        '[thinking] I will state my plan.',
        '[agent] I will run echo hi.',
        '[tool] run_terminal_command {"command":"echo hi"}',
        '[tool completed] hi',
        '[agent] It printed hi.',
        '[done] end_turn',
        ''
    ].join('\n'));
});

test('Antigravity events show replies and tool steps', () => {
    const { text } = runTranscript('agy-stream', AGY_EVENTS);

    assert.equal(text, [
        '[agent] I am about to run echo hi.',
        '[tool] run_command {"CommandLine":"echo hi"}',
        '[tool done] run_command',
        '[agent] It printed hi.',
        '[done] SUCCESS',
        ''
    ].join('\n'));
});

test('single-answer formats are written when the run ends', () => {
    const grok = createTranscript('grok');
    grok.finish(JSON.stringify({ text: 'Done.', thought: 'Plan.' }), '');
    assert.equal(grok.getText(), '[thinking] Plan.\n[agent] Done.\n');

    const agy = createTranscript('agy');
    agy.finish('The picture is ready.\n', '');
    assert.equal(agy.getText(), '[agent] The picture is ready.\n');

    const claude = createTranscript('claude');
    claude.finish(JSON.stringify({ result: 'Hello.' }), '');
    assert.equal(claude.getText(), '[agent] Hello.\n');
});

test('errors on stderr are kept but the stdin notice is not', () => {
    const { text } = runTranscript(
        'codex',
        '',
        'Reading additional input from stdin...\nquota exceeded\n'
    );
    assert.equal(text, '');

    const live = createTranscript('codex');
    live.push('stderr', 'Reading additional input from stdin...\nquota exceeded\n');
    live.finish('', '');
    assert.equal(live.getText(), '[stderr] quota exceeded\n');
});

test('an unknown event or a plain line is kept rather than lost', () => {
    const { text } = runTranscript(
        'codex',
        '{"type":"item.completed","item":{"id":"i","type":"image_generation","path":"C:\\\\a.png"}}\nsome plain line\n'
    );
    assert.equal(text, '[image_generation] {"type":"image_generation","path":"C:\\\\a.png"}\n[output] some plain line\n');
});

test('the record is cut when it gets too long', () => {
    const transcript = createTranscript('codex');
    const line = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(1500) } });
    for (let count = 0; count < 300; count += 1) transcript.push('stdout', `${line}\n`);
    transcript.finish('', '');

    assert.ok(transcript.getText().length < 205 * 1000);
    assert.match(transcript.getText(), /\[record cut: too long\]/);
});

test('Codex asks for thinking summaries only when told to', () => {
    const plain = buildArgs({ cli: 'codex', prompt: 'p' });
    assert.ok(!plain.args.some(argument => /model_reasoning_summary/.test(argument)));

    const asked = buildArgs({ cli: 'codex', prompt: 'p', reasoningSummary: 'detailed' });
    assert.ok(asked.args.includes('model_reasoning_summary=detailed'));
    assert.equal(asked.args.at(-1), 'p', 'the prompt stays last');
});

test('streaming output is switched on only when asked for', () => {
    const grokPlain = buildArgs({ cli: 'grok', prompt: 'p' });
    assert.equal(grokPlain.parse, 'grok');
    assert.equal(grokPlain.args[grokPlain.args.indexOf('--output-format') + 1], 'json');

    const grokStream = buildArgs({ cli: 'grok', prompt: 'p', streaming: true });
    assert.equal(grokStream.parse, 'grok-stream');
    assert.equal(grokStream.args[grokStream.args.indexOf('--output-format') + 1], 'streaming-json');

    const agyPlain = buildArgs({ cli: 'agy', prompt: 'p' });
    assert.equal(agyPlain.parse, 'agy');
    assert.ok(!agyPlain.args.includes('--output-format'));

    const agyStream = buildArgs({ cli: 'agy', prompt: 'p', streaming: true });
    assert.equal(agyStream.parse, 'agy-stream');
    assert.equal(agyStream.args[agyStream.args.indexOf('--output-format') + 1], 'stream-json');
    assert.equal(agyStream.args.at(-1), 'p');
});

test('the answer and session are read out of Grok and Antigravity streams', () => {
    assert.deepEqual(parseOutput('grok-stream', GROK_EVENTS, null), {
        text: 'I will run echo hi.It printed hi.',
        sessionId: 'g-1',
        error: null
    });
    assert.deepEqual(parseOutput('agy-stream', AGY_EVENTS, null), {
        text: 'It printed hi.\n',
        sessionId: 'a-1',
        error: null
    });
});

test('a failed Grok stream reports the error and no answer', () => {
    const parsed = parseOutput('grok-stream', '{"type":"text","data":"x"}\n{"type":"error","message":"no quota"}\n', null);
    assert.equal(parsed.text, null);
    assert.equal(parsed.error, 'no quota');
});

test('an Antigravity stream without a result rebuilds the answer from the last reply', () => {
    const cut = AGY_EVENTS.split('\n').slice(0, -1).join('\n');
    const parsed = parseOutput('agy-stream', cut, null);
    assert.equal(parsed.text, 'It printed hi.');
    assert.equal(parsed.sessionId, 'a-1');
});
