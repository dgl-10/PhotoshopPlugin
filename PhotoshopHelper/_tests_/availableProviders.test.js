const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    filterProvidersWithApiKeys,
    getValidGenerationModes
} = require('../availableProviders');

const providersData = {
    response_handlers: {
        sync: {
            type: 'sync',
            note: '{{env:HANDLER_KEY}}'
        }
    },
    providers: [
        {
            id: 'needs_fal',
            name: 'Fal',
            generation_modes: ['t2i', 'i2i'],
            request_config: {
                headers: { Authorization: 'Bearer {{env:FAL_API_KEY}}' }
            }
        },
        {
            id: 'needs_handler_key',
            name: 'Handler',
            generation_modes: ['t2i'],
            response_config: { $ref: 'sync' }
        },
        {
            id: 'no_keys',
            name: 'Local',
            generation_modes: ['i2i']
        }
    ]
};

describe('filterProvidersWithApiKeys', () => {
    it('keeps providers whose required env keys are present', () => {
        const available = filterProvidersWithApiKeys(providersData, {
            FAL_API_KEY: 'present'
        });
        assert.deepEqual(available.map(provider => provider.id), ['needs_fal', 'no_keys']);
    });

    it('also scans referenced response handlers for env keys', () => {
        const available = filterProvidersWithApiKeys(providersData, {
            HANDLER_KEY: 'present'
        });
        assert.deepEqual(available.map(provider => provider.id), ['needs_handler_key', 'no_keys']);
    });

    it('treats blank keys as missing', () => {
        const available = filterProvidersWithApiKeys(providersData, {
            FAL_API_KEY: '   '
        });
        assert.deepEqual(available.map(provider => provider.id), ['no_keys']);
    });
});

describe('getValidGenerationModes', () => {
    it('returns unique t2i/i2i modes', () => {
        assert.deepEqual(
            getValidGenerationModes({ generation_modes: ['i2i', 't2i'] }),
            ['i2i', 't2i']
        );
    });

    it('rejects missing, empty, duplicate, or unknown modes', () => {
        assert.equal(getValidGenerationModes({}), null);
        assert.equal(getValidGenerationModes({ generation_modes: [] }), null);
        assert.equal(getValidGenerationModes({ generation_modes: ['t2i', 't2i'] }), null);
        assert.equal(getValidGenerationModes({ generation_modes: ['video'] }), null);
        assert.equal(getValidGenerationModes({ generation_modes: ['t2i', 'svg'] }), null);
    });
});
