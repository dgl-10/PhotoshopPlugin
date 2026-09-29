'use strict';

/**
 * Centralized repository of all prompt templates used by the CLI agent system.
 *
 * Prompts are never executed automatically. A human action (e.g. clicking
 * "Refresh Models" in the CLI Model Config window) must trigger each one
 * explicitly for the specific CLI the user wants to query.
 */

/**
 * Builds the prompt sent to a CLI to retrieve its available models and
 * recommended tier configuration.
 *
 * Rules encoded in the prompt:
 * - recommended_tiers has exactly 3 keys: Light, Medium, High.
 *   Ultra-tier models must NOT appear in recommended_tiers.
 * - Ultra_Power group is still present in all_available_models so the user
 *   can pick those models manually if they wish.
 * - supports_native_image_generation refers to built-in image generation
 *   capability only — not any MCP server or plugin.
 *
 * @returns {string} The prompt string ready to be passed to the CLI.
 */
function buildModelListPrompt() {
    return `Please analyze all AI models currently available to you and provide two things:
1. A recommendation for three specific tiers ("Light", "Medium", and "High").
   - Note on "Light": This should NOT be your absolute weakest model. Think of it as "Light+". It should be a capable, mid-tier model running at a low "effort" setting, prioritizing speed and cost while maintaining a solid reasoning baseline.
   - Note on "High": This is the most powerful tier you should recommend for everyday use. Do NOT recommend Ultra-tier models (such as Claude Fable or GPT-6 Astra) here — those are research-grade and belong only in the all_available_models list.
2. A comprehensive list of all your available models grouped by their intrinsic power/strength.
   - Group them into four categories: "Ultra_Power", "High_Power", "Medium_Power", and "Light_Power".
   - Ultra_Power: reserve this group ONLY for next-generation "super" models (e.g. Claude Fable, GPT-6 Astra). If none exist, return an empty array.
   - WITHIN each group, sort the models by version in DESCENDING order (latest/newest versions first, older versions last).
   - For every single model in this list, specify an array of all possible "effort" settings available for it.

Additionally, report whether you support built-in image generation (including native CLI tools such as generate_image, image_gen, or /imagine; NOT via external MCP servers or user plugins). If you have built-in image generation tools, set "supports_native_image_generation" to true, otherwise false.
` +
    // Previous prompt instruction without tool restriction:
    // `\nYou must return the result STRICTLY as a valid JSON object. Do not include any markdown formatting (such as \`\`\`json), explanations, or conversational text. Output ONLY the JSON.\n`
    `
Do NOT use web search, URL fetching, or external tools. Answer immediately using your internal knowledge.
You must return the result STRICTLY as a valid JSON object. Do not include any markdown formatting (such as \`\`\`json), explanations, or conversational text. Output ONLY the JSON.

Use the following JSON schema as a reference:
{
  "supports_native_image_generation": true,
  "recommended_tiers": {
    "Light": {
      "model": "model_name_here",
      "effort": "low"
    },
    "Medium": {
      "model": "model_name_here",
      "effort": "medium"
    },
    "High": {
      "model": "model_name_here",
      "effort": "high"
    }
  },
  "all_available_models": {
    "Ultra_Power": [],
    "High_Power": [
      {
        "model": "model_name_v3.8",
        "available_efforts": ["low", "medium", "high"]
      },
      {
        "model": "model_name_v3.7",
        "available_efforts": ["low", "medium", "high"]
      }
    ],
    "Medium_Power": [
      {
        "model": "model_name_v2.5",
        "available_efforts": ["low", "medium"]
      }
    ],
    "Light_Power": [
      {
        "model": "model_name_v1.0",
        "available_efforts": ["low"]
      }
    ]
  }
}`;
}

/**
 * Build a provider-neutral instruction for Codex, Grok, or Antigravity.
 *
 * The person's image prompt is JSON-encoded so leading/trailing whitespace and quotes are
 * unambiguous. In strict mode the CLI is explicitly told to pass the decoded string to its
 * native image tool verbatim; workflow instructions, paths, count, and ratio stay separate.
 *
 * @param {object} options - Normalized generation request.
 * @returns {string} Prompt for the command-line agent.
 */
function buildCliImagePrompt({
    prompt,
    doNotChangePrompt,
    numImages,
    aspectRatio,
    sourcePath,
    referencePaths,
    outputDir,
    outputDirectoryRequired = false
}) {

    const normalizedRatio = String(aspectRatio || '').trim();
    const hasAspectRatio = Boolean(normalizedRatio && normalizedRatio.toLowerCase() !== 'auto');

    const promptRule = doNotChangePrompt
        ? (
            'Decode prompt_json and pass that exact string verbatim to the native image-generation tool. Do not rewrite, expand, translate, correct, or decorate it.'
            + (hasAspectRatio
                ? ` Use the native tool parameter for aspect_ratio (${normalizedRatio}) if available; if the tool lacks an aspect ratio parameter, you may append the requested aspect ratio to the prompt.`
                : '')
        )
        : ''; //You may improve prompt_json before passing it to the native image-generation tool when that helps produce a better image.';

    const hasMultipleImages = Number(numImages) > 1;

    const hasSourceImage = Boolean(sourcePath && String(sourcePath).trim());
    const hasReferenceImages = Array.isArray(referencePaths) && referencePaths.length > 0;

    const sections = [];

    // Header & capabilities
    const headerLines = [
        'Generate a new image using your built-in/native image-generation tool.',
        'Do not use an external paid API, an MCP image server, or a user-installed image plugin.'
    ];
    if (promptRule) {
        headerLines.push(promptRule);
    }
    sections.push(headerLines.join('\n'));

    // Parameters block
    const paramLines = [];
    if (!doNotChangePrompt) {
        paramLines.push(`prompting_instructions_json: ${JSON.stringify(prompt)}`);
    } else {
        paramLines.push(`prompt_json: ${JSON.stringify(prompt)}`);
    }
    if (hasMultipleImages) {
        paramLines.push(`requested_image_count: ${numImages}`);
    }
    if (hasAspectRatio) {
        paramLines.push(`aspect_ratio: ${JSON.stringify(normalizedRatio)}`);
    }
    if (hasSourceImage) {
        paramLines.push(`primary_source_image: ${JSON.stringify(sourcePath)}`);
    }
    if (hasReferenceImages) {
        paramLines.push(`additional_reference_images: ${JSON.stringify(referencePaths)}`);
    }
    if (outputDirectoryRequired && outputDir) {
        paramLines.push(`output_directory: ${JSON.stringify(outputDir)}`);
    }
    sections.push(paramLines.join('\n'));

    // Instructions block
    const instructionLines = [];
    if (hasSourceImage) {
        instructionLines.push('Use the primary source as the original picture.');
    }
    if (hasReferenceImages) {
        instructionLines.push('Use additional reference images as image inputs.');
    }
    if (hasAspectRatio) {
        instructionLines.push(`Use the requested aspect ratio (${normalizedRatio}) through a native tool parameter when available. If the tool has no aspect ratio parameter, append the requested aspect ratio to the prompt text.`);
    }
    if (hasMultipleImages) {
        instructionLines.push('Ask for the requested count in one native generation call when possible. If the tool creates more images, keep and report all of them.');
    }
    if (outputDirectoryRequired && outputDir) {
        instructionLines.push('Save every final raster image in output_directory. Create the directory if needed.');
    }
    // Some CLIs create more images than asked for, or retry after a failed attempt. That is
    // left alone; the reply format below only requires that every file that was made is listed.
    //instructionLines.push('Do not generate extra images on purpose.');
    //instructionLines.push('Please report for all generated images');

    instructionLines.push('Do not modify any input file.');
    sections.push(instructionLines.join('\n'));

    // Output schema
    const footerLines = [
        'After the tool finishes, reply with JSON only. In final_prompt, include the exact prompt sent to the image generation tool. Use absolute file paths:',
        '{"status":"done","images":[{"path":"ABSOLUTE_PATH_OF_IMAGE_1"},{"path":"ABSOLUTE_PATH_OF_IMAGE_2"}],"final_prompt":"EXACT_PROMPT_SENT_TO_IMAGE_GENERATION_TOOL"}',
        '"images" holds one object for every image file created during this task, in creation order, however many that is: one object if one file was created, more if more were. Do not invent paths and do not repeat one.',
        'On failure, reply with JSON only:',
        '{"status":"error","error":{"code":"moderation|invalid_aspect_ratio|quota_exhausted|timeout|generation_failed","message":"SHORT_MESSAGE"}}'
    ];
    footerLines.push('Please report for all generated images.');
    sections.push(footerLines.join('\n'));

    return sections.join('\n\n');
}

module.exports = { buildModelListPrompt, buildCliImagePrompt };
