Task Parameters:

MODEL_ID = "[Insert Model ID here, or ask the user if not provided]"
PROVIDER_NAME = "[Insert Provider Name/API here, or ask the user if not provided]"
API_KEY_ENV_VAR = "[Insert API Key Env Var here, or ask the user if not provided]"

CRITICAL INSTRUCTION: Before starting, VERIFY that the user has clearly specified the MODEL_ID, the target PROVIDER_NAME, and the API_KEY_ENV_VAR. If any of these are missing, DO NOT proceed with generating the configuration. Instead, immediately ask the user to provide the missing details.

Using the attached `Providers_Configuration_Guide.md`, create a ready-to-use JSON5 provider configuration for the `MODEL_ID` model, working directly through the specified provider's API.

IMPORTANT: The configuration is STRICTLY intended for IMAGE EDITING tasks (img2img / in-painting / out-painting / image variations), not for generating new images from scratch (txt2img). Ensure you are using the correct endpoint for editing (e.g., `/v1/images/edits` for OpenAI).

Substitute the provided parameters into the final configuration. The API key must be read from an environment variable:

"Authorization": "Bearer {{env:<API_KEY_ENV_VAR>}}"

Do not place the actual API key value in the code, and do not create a UI field for it.

Use the guide as your source of information regarding the provider structure, placeholders, system parameters, preprocessors, and response handlers.

Retrieve up-to-date information about the model itself and the Provider's API via MCP Context7. If it is unavailable or lacks the necessary information, use the official documentation of the provider. Do not blindly copy parameters from other GPT-Image models without verifying them.

Verify:

- The exact endpoint (specifically for img2img/editing) and model identifier;
- The authorization method;
- The request body format;
- Mandatory and optional fields;
- Support for and proper transmission of the source image (`init_image`), reference images, and masks;
- The allowed number and formats of input images;
- The dimensions and aspect ratios of the output;
- Output quality and format parameters;
- The number of images per request;
- The API response structure.

Keep in mind that the provider system forms the request from the `body_template` or sends data according to the configuration.

For each API property, independently choose one of the following options:

- A user parameter;
- A fixed value in the `body_template`;
- A conditionally passed field;
- A field that can be omitted.

Do not overload the interface. Expose as parameters only the settings that are actually useful for the user to tweak. Hardcode technical values and the model identifier directly in the configuration.

Do not re-declare system parameters that are already provided by the application, such as `prompt`, `num_images`, and `aspect_ratio`. Use them in accordance with the guide.

Pay special attention to images (since this is an img2img task):

- Ensure that the source image (`init_image`) and/or the mask are correctly passed to the API;
- Choose the correct `image_format`;
- Configure `mask_handling`;
- Specify the correct `max_reference_images`;
- Check the requirements for mask transparency;
- Configure the allowed aspect ratios and output dimensions.

Add a preprocessor only when it is required to comply with API limits, prepare a mask, genuinely reduce image dimensions to optimize costs, or ensure compatibility with restrictions outlined in the API.

Pricing & Optimization Strategy:

- Analyze the provider's pricing model deeply (e.g., is it billed per-megapixel, per-token, or per-image bracket?). Identify any minimum billable sizes (e.g., min area limits) and maximum resolution limits.
- If the API charges based on image size or input tokens, design UI parameters (e.g., `input_optimization` or `output_resolution_mp` dropdowns) that allow the user to control the cost-vs-quality tradeoff. Provide informative labels in the UI with estimated costs (e.g., '1mp [~ 1K]').
- Use advanced preprocessor chains like `image_optimizer_mp` combined with `image_get_size_mp` for area-based billing APIs to downscale input images and references precisely, ensuring the user doesn't overpay for massive source files.

Use an existing response handler if it fits. When processing the response, correctly distinguish between URLs, Data URIs, and raw Base64. Do not specify one format for data of another type.

Do not analyze the JavaScript code. Work based on the guide and official documentation. If examples of existing providers are provided, stick to the same style.

Ask a clarifying question only in cases of significant ambiguity that cannot be resolved using the documentation. In all other cases, make a reasonable decision independently.

Output:

1. The ready-to-use provider object in JSON5 format;
2. A separate response handler, only if the existing one is unsuitable;
3. A brief explanation of the key decisions made;
4. Links to the official documentation used to verify the API.

Write comments inside the JSON5 in English.
