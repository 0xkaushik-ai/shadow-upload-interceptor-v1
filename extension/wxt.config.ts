import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'SecureIntent Shadow Upload',
    description: 'Stops files containing private keys before they reach the page.',
    // Public development key: pins the unpacked extension ID so the one-command
    // demo can install an exact Native Messaging allowed_origin. It is not a secret.
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA7T/J4kOjJdZdGndIY1aAp6WSI2LSZMK3VKts/ZbMeqc2mEVdlVDbEN7ZvJZAHZV/m6zVRbUfK3YWGp3lQsXaGE5t2F+Wnojj/cA5ksSsUX4wdEwtCGVmlOJVqYzNq78lmW5wuwUwrq+ZZoRZnhApq5Rv1ObJYC/MhE5EPHiY8Bf50FW/e2JsVtwfxHUjYwVo37AJxgQdGCgkmNeZv8Peas2+asvl+rDCSit79MNL1S/3JQzLXh5ivWyIOfHoVsFwGDlwy5ihLLcWnsaKNmxiAC9J/+zDfmt4sEBlNyCmbMUjgq5IfpCytVRBOTAnuj5aL3bDMesx7Kw2K3ms6LpCHwIDAQAB',
    permissions: ['nativeMessaging', 'storage'],
    storage: {
      managed_schema: 'policy_schema.json',
    },
    minimum_chrome_version: '148',
    // Chrome 148+: typed arrays are copied between the content script and MV3
    // worker. Native Messaging itself remains JSON-only.
    message_serialization: 'structured_clone',
  },
});
