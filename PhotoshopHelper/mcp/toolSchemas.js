const { z } = require('zod');

const LIST_PROVIDERS_DESCRIPTION = [
    'Use this first. Return providers whose required API keys are present and that declare t2i and/or i2i.',
    'Pick a provider by id and generation_modes.',
    'Call get_providers_details only for the ids you intend to use.'
].join(' ');

const GET_PROVIDERS_DETAILS_DESCRIPTION = [
    'Call only for selected ids before generate_image, and only when parameter names, enums, or constraints are not already known.',
    'Do not request every provider.'
].join(' ');

const GENERATE_IMAGE_DESCRIPTION = [
    'providerId comes from list_providers.',
    'Provider-specific keys go in params using names from get_providers_details.',
    'prompt is a convenience alias for params.prompt.',
    'Text-to-image requires aspect_ratio and no source/references.',
    'Image-to-image uses sourceImagePath and optional mask/references.',
    'All image fields are absolute paths to existing files.',
    'The result is absolute output paths in the shared temp directory, not a Photoshop layer.'
].join(' ');

const listProvidersInputSchema = {
    mode: z.enum(['t2i', 'i2i']).optional().describe(
        'Optional filter. Return only providers that list this generation mode.'
    )
};

const getProvidersDetailsInputSchema = {
    providerIds: z.array(z.string()).min(1).describe(
        'Provider ids from list_providers. Wildcard "*" is not accepted.'
    )
};

const generateImageInputSchema = {
    providerId: z.string().describe('Provider id from list_providers.'),
    prompt: z.string().optional().describe(
        'Convenience alias mapped to params.prompt. Wins over params.prompt when both are set.'
    ),
    sourceImagePath: z.string().optional().describe('Absolute path to the source image.'),
    maskImagePath: z.string().optional().describe('Absolute path to the inpainting mask.'),
    referenceImagePaths: z.array(z.string()).optional().describe(
        'Ordered absolute paths to reference images.'
    ),
    aspect_ratio: z.string().optional().describe(
        'Required for text-to-image. Optional for image-to-image.'
    ),
    num_images: z.number().int().min(1).max(100).optional().describe(
        'Requested output count. Defaults to 1.'
    ),
    use_mask: z.boolean().optional().describe(
        'Defaults to true when maskImagePath is supplied. false ignores the mask.'
    ),
    force_separate_requests: z.boolean().optional().describe(
        'Force one provider request per output. Defaults to false.'
    ),
    params: z.record(z.string(), z.any()).optional().describe(
        'Provider-specific parameters. Keys match get_providers_details parameter names.'
    ),
    timeout_seconds: z.number().int().min(1).max(600).optional().describe(
        'Maximum time to wait for the executor to finish. Defaults to 180.'
    )
};

module.exports = {
    LIST_PROVIDERS_DESCRIPTION,
    GET_PROVIDERS_DETAILS_DESCRIPTION,
    GENERATE_IMAGE_DESCRIPTION,
    listProvidersInputSchema,
    getProvidersDetailsInputSchema,
    generateImageInputSchema
};
