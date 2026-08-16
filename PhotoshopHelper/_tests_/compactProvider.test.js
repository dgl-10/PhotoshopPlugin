const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    compactProviderDetails,
    getProvidersDetails,
    selectMcpProviders,
    toProviderSummaries
} = require('../mcp/compactProvider');

const seedream = {
    id: 'seedream_v4_5_fal',
    name: 'Seedream v4.5 via Fal API Key',
    generation_modes: ['t2i', 'i2i'],
    allowed_aspect_ratios: ['1:1', '16:9'],
    max_reference_images: {
        default: 2,
        depends_on: 'model',
        values: { pro: 4 }
    },
    mask_handling: {
        supported: true,
        required: false,
        type: 'first_referential',
        field_name: 'images'
    },
    supports_negative_prompt: false,
    nice_name: 'hidden from MCP',
    remarks: '<b>UI chrome</b>',
    request_config: { single_image_per_request: true, endpoint_url: 'https://example' },
    response_config: { $ref: 'sync' },
    preprocessor: [],
    image_format: 'data_uri',
    filename_suffix: 'seedream',
    parameters: [
        {
            name: 'prompt',
            type: 'string',
            alias: 'prompt',
            label: 'Text Prompt',
            default: ''
        },
        {
            name: 'resolution',
            type: 'dropdown',
            alias: 'output_resolution',
            label: 'Resolution',
            default: '1k',
            options: [
                { value: '1k', alias: 'std', label: 'Standard' },
                { value: '2k', alias: 'high' },
                { value: '2k', alias: 'ultra', hidden: true }
            ]
        },
        {
            name: 'guidance',
            type: 'slider',
            min: 1,
            max: 10,
            step: 0.5,
            default: 4
        }
    ]
};

const videoOnly = {
    id: 'future_video',
    name: 'Video',
    generation_modes: ['video']
};

describe('toProviderSummaries', () => {
    it('omits UI chrome and providers without valid generation_modes', () => {
        const result = toProviderSummaries(selectMcpProviders([seedream, videoOnly]));
        assert.deepEqual(result, {
            providers: [{
                id: 'seedream_v4_5_fal',
                name: 'Seedream v4.5 via Fal API Key',
                generation_modes: ['t2i', 'i2i']
            }]
        });
    });

    it('filters by requested mode', () => {
        const i2iOnly = { ...seedream, id: 'i2i_only', generation_modes: ['i2i'] };
        const result = toProviderSummaries(selectMcpProviders([seedream, i2iOnly]), 't2i');
        assert.deepEqual(result.providers.map(provider => provider.id), ['seedream_v4_5_fal']);
    });
});

describe('compactProviderDetails', () => {
    it('keeps model-facing fields and strips WebHelper chrome', () => {
        const details = compactProviderDetails(seedream);
        assert.deepEqual(details, {
            id: 'seedream_v4_5_fal',
            name: 'Seedream v4.5 via Fal API Key',
            generation_modes: ['t2i', 'i2i'],
            allowed_aspect_ratios: ['1:1', '16:9'],
            max_reference_images: {
                default: 2,
                depends_on: 'model',
                values: { pro: 4 }
            },
            mask_handling: { supported: true, required: false },
            supports_negative_prompt: false,
            single_image_per_request: true,
            parameters: [
                { name: 'prompt', type: 'string', default: '' },
                { name: 'resolution', type: 'dropdown', default: '1k', options: ['1k', '2k'] },
                { name: 'guidance', type: 'slider', default: 4, min: 1, max: 10, step: 0.5 }
            ]
        });
        assert.equal(details.mask_handling.type, undefined);
        assert.equal(details.nice_name, undefined);
        assert.equal(details.remarks, undefined);
        assert.equal(details.request_config, undefined);
    });

    it('does not emit single_image_per_request when it is not true', () => {
        const details = compactProviderDetails({
            ...seedream,
            request_config: { endpoint_url: 'https://example' }
        });
        assert.equal(details.single_image_per_request, undefined);
    });
});

describe('getProvidersDetails', () => {
    it('returns notFound for inactive ids without failing the call', () => {
        const result = getProvidersDetails([seedream], ['seedream_v4_5_fal', 'missing']);
        assert.equal(result.providers.length, 1);
        assert.deepEqual(result.notFound, ['missing']);
    });

    it('rejects empty arrays and wildcard ids as input errors', () => {
        assert.match(getProvidersDetails([seedream], []).error, /non-empty/);
        assert.match(getProvidersDetails([seedream], ['*']).error, /Wildcard/);
        assert.match(getProvidersDetails([seedream], undefined).error, /non-empty/);
    });
});
