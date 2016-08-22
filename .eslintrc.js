module.exports = {
  'parser': 'babel-eslint',
  'parserOptions': {
    'ecmaFeatures': {
      'jsx': true,
    },
  },
  'extends': 'airbnb',
  'rules': {
    'eqeqeq': ['error', 'allow-null'],
    'no-void': 'error',
    'react/jsx-filename-extension': ['error', { "extensions": [".js"] }],
    'graphql/template-strings': ['error', {
      'env': 'relay',
      'schemaJson': require('./build/schema.json'),
    }],
  },
  settings: {
    'import/resolver': 'webpack',
  },
  'env': {
    'browser': true,
    'mocha': true,
    'node': true,
  },
  'plugins': [
    'react',
    'graphql',
  ],
};
