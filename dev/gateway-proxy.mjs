/**
 * Dev-server plugin: forwards /__fusion_gateway/* to fusion-gateway so the browser
 * talks to one origin. The gateway's CORS allowlist does not include the dev
 * servers, and a rejected preflight reaches the app as "Failed to fetch".
 */
const target = process.env.FUSION_GATEWAY_URL || 'http://127.0.0.1:11432';

export default function gatewayProxy() {
    return {
        name: 'fusion-gateway-proxy',
        apply: 'serve',
        config() {
            return {
                server: {
                    proxy: {
                        '/__fusion_gateway': {
                            target,
                            changeOrigin: false,
                            rewrite: (path) => path.replace(/^\/__fusion_gateway/, ''),
                        },
                    },
                },
            };
        },
    };
}
