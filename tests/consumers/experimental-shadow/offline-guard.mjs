for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY']) process.env[name] = 'synthetic-offline-placeholder';
process.env.TACHIKOMA_RUN_LIVE_TESTS = '0';
export const networkAttempts = [];
const block = async () => { networkAttempts.push('blocked'); throw new Error('Offline shadow consumer may not access the network'); };
block.preconnect = () => { throw new Error('Offline shadow consumer may not preconnect'); };
globalThis.fetch = block;
