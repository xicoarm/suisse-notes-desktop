module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2021: true
  },
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-recommended'
  ],
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module'
  },
  rules: {
    'vue/multi-word-component-names': 'off',
    'no-unused-vars': 'warn',
    'no-console': 'off'
  },
  overrides: [
    {
      // App code shared by desktop and mobile: an API body is read through
      // services/api (readJson / parseJsonSafe), never response.json(). A
      // gateway or captive-portal HTML page otherwise surfaces as
      // "SyntaxError: Unexpected token '<'" (ELECTRON-6E).
      files: ['src/**/*.js', 'src/**/*.vue'],
      rules: {
        'no-restricted-syntax': ['error', {
          selector: "CallExpression[callee.type='MemberExpression'][callee.property.name='json'][arguments.length=0]",
          message: 'Read API bodies with readJson()/parseJsonSafe() from services/api: an HTML error page must not throw a SyntaxError.'
        }]
      }
    }
  ]
}
