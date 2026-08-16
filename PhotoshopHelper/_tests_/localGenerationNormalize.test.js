const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeGenerationRequest } = require('../localGenerationApi');

describe('normalizeGenerationRequest', () => {
    it('requires aspect_ratio for text-to-image', () => {
        assert.throws(
            () => normalizeGenerationRequest({
                providerId: 'seedream_v4_5_fal',
                params: { prompt: 'a cloud' }
            }),
            { message: '"aspect_ratio" is required for text-to-image generation.' }
        );
    });

    it('rejects a relative source path before a generation exists', () => {
        assert.throws(
            () => normalizeGenerationRequest({
                providerId: 'seedream_v4_5_fal',
                sourceImagePath: 'relative.png'
            }),
            { message: '"sourceImagePath" must be an absolute file path.' }
        );
    });

    it('accepts an absolute existing source and optional mask off switch', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-api-'));
        const sourcePath = path.join(tempDir, 'source.png');
        fs.writeFileSync(sourcePath, 'png');

        const request = normalizeGenerationRequest({
            providerId: 'seedream_v4_5_fal',
            sourceImagePath: sourcePath,
            use_mask: false,
            params: { prompt: 'edit' }
        });

        assert.equal(request.useMask, false);
        assert.equal(request.sourceImagePath, path.normalize(sourcePath));
        assert.equal(request.aspectRatio, undefined);
    });
});
