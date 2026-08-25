const js = require('@eslint/js');

module.exports = [
    {
        ignores: ['node_modules/', 'feeds/', 'images/']
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly',
                module: 'writable',
                process: 'readonly',
                console: 'readonly',
                __dirname: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                setInterval: 'readonly',
                URLSearchParams: 'readonly',
                fetch: 'readonly',
                navigator: 'readonly',
                AbortSignal: 'readonly'
            }
        },
        rules: {
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
            'no-async-promise-executor': 'error',
            'no-dupe-keys': 'error',
            'prefer-const': 'warn'
        }
    }
];
