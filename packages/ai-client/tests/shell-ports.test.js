import { describe, it, expect, vi, afterEach } from 'vitest';
import { baseUrlFor, configure } from '../src/index.js';

// Vitest runs with DEV=true, so the default base is the /__fusion_gateway
// dev proxy; pin the base to a sentinel so port membership is observable.
afterEach(() => {
    configure({ baseUrl: 'http://127.0.0.1:11432' });
});

describe('VITE_FUSION_SHELL_PORTS (#65)', () => {
    it('keeps the default office shell ports', () => {
        configure({ baseUrl: 'http://cb-default:9/' });
        expect(baseUrlFor(new URL('http://localhost:11486/x'))).toBe('/__fusion_gateway');
        expect(baseUrlFor(new URL('http://localhost:9999/x'))).toBe('http://cb-default:9/');
    });

    it('extends the shell-served set from the env at module load', async () => {
        vi.resetModules();
        vi.stubEnv('VITE_FUSION_SHELL_PORTS', '12345, 6789');
        const mod = await import('../src/index.js');
        try {
            mod.configure({ baseUrl: 'http://cb-extended:9/' });
            expect(mod.baseUrlFor(new URL('http://localhost:12345/x'))).toBe('/__fusion_gateway');
            expect(mod.baseUrlFor(new URL('http://localhost:6789/x'))).toBe('/__fusion_gateway');
            expect(mod.baseUrlFor(new URL('http://localhost:9999/x'))).toBe('http://cb-extended:9/');
        } finally {
            vi.unstubAllEnvs();
            vi.resetModules();
        }
    });
});
