import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    { ignores: ['dist/**', 'node_modules/**'] },
    {
        files: ['**/*.config.js'],
        languageOptions: { sourceType: 'commonjs', globals: { module: 'writable', require: 'readonly' } },
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
)
