const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizeGenerationRequest } = require('../localGenerationApi');
const { createGenerateImageHandler, mapGenerateImageArgs } = require('../mcp/generateImage');

function parseToolJson(result) {
    return JSON.parse(result.content[0].text);
}

describe('mapGenerateImageArgs', () => {
    it('maps the top-level prompt over params.prompt', () => {
        const body = mapGenerateImageArgs({
            providerId: 'seedream_v4_5_fal',
            prompt: 'from alias',
            params: { prompt: 'from params', resolution: '1k' },
            timeout_seconds: 30
        });

        assert.equal(body.params.prompt, 'from alias');
        assert.equal(body.params.resolution, '1k');
        assert.equal(body.timeout_seconds, undefined);
        assert.equal(body.providerId, 'seedream_v4_5_fal');
    });
});

describe('createGenerateImageHandler', () => {
    it('returns a tool error for malformed input and does not start generation', async () => {
        let generateCalls = 0;
        const handler = createGenerateImageHandler({
            generate: async () => {
                generateCalls += 1;
                return [];
            },
            tempDir: os.tmpdir()
        });

        const result = await handler({
            providerId: 'seedream_v4_5_fal',
            prompt: 'no ratio and no images'
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /aspect_ratio/);
        assert.equal(generateCalls, 0);
    });

    it('returns status failed for executor errors without isError', async () => {
        const handler = createGenerateImageHandler({
            generate: async () => {
                throw new Error('Provider unavailable');
            },
            tempDir: os.tmpdir()
        });

        const result = await handler({
            providerId: 'seedream_v4_5_fal',
            aspect_ratio: '1:1',
            prompt: 'a cloud'
        });

        assert.equal(result.isError, undefined);
        const payload = parseToolJson(result);
        assert.equal(payload.status, 'failed');
        assert.equal(payload.error, 'Provider unavailable');
        assert.deepEqual(payload.outputPaths, []);
        assert.equal(typeof payload.generationId, 'string');
        assert.equal(typeof payload.durationMs, 'number');
    });

    it('waits for the executor and returns absolute output paths', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-gen-'));
        const outputPath = path.join(tempDir, 'out.png');
        fs.writeFileSync(outputPath, 'png');

        let accepted = 0;
        const handler = createGenerateImageHandler({
            generate: async () => [{ status: 'done', image: outputPath }],
            tempDir,
            onGenerationAccepted: () => {
                accepted += 1;
            }
        });

        const result = await handler({
            providerId: 'seedream_v4_5_fal',
            aspect_ratio: '1:1',
            prompt: 'a cloud'
        });

        const payload = parseToolJson(result);
        assert.equal(payload.status, 'completed');
        assert.deepEqual(payload.outputPaths, [path.normalize(outputPath)]);
        assert.equal(accepted, 1);
        assert.equal(
            normalizeGenerationRequest(mapGenerateImageArgs({
                providerId: 'seedream_v4_5_fal',
                aspect_ratio: '1:1',
                prompt: 'a cloud'
            })).params.prompt,
            'a cloud'
        );
    });

    it('returns a named timeout without cancelling the executor', async () => {
        let finished = false;
        const handler = createGenerateImageHandler({
            generate: async () => {
                await new Promise(resolve => setTimeout(resolve, 80));
                finished = true;
                return [{ status: 'done', image: 'C:\\tmp\\late.png' }];
            },
            tempDir: os.tmpdir()
        });

        const result = await handler({
            providerId: 'seedream_v4_5_fal',
            aspect_ratio: '1:1',
            prompt: 'slow',
            // Handler is tested directly; Zod enforces 1–600 on the MCP boundary.
            timeout_seconds: 0.03
        });

        const payload = parseToolJson(result);
        assert.equal(payload.status, 'failed');
        assert.match(payload.error, /timed out after 0.03 seconds/);
        assert.equal(finished, false);
        await new Promise(resolve => setTimeout(resolve, 120));
        assert.equal(finished, true);
    });
});
