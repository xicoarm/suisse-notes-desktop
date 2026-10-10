// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// electron-main.js cannot be loaded outside Electron: compile the helper and
// check the call site from source.
const source = fs.readFileSync('src-electron/electron-main.js', 'utf8').replace(/\r\n/g, '\n');
const helper = /function isCustomerFixableRegisterRefusal\(failure\) \{[\s\S]*?\n\}/.exec(source)?.[0];
const isCustomerFixable = new Function(`${helper}\nreturn isCustomerFixableRegisterRefusal;`)();

describe('failed registration logging (main process)', () => {
  it('customer-fixable refusals stay local (info), outages reach Sentry (warn)', () => {
    expect(isCustomerFixable({ status: 400 })).toBe(true);
    expect(isCustomerFixable({ status: 409 })).toBe(true);
    expect(isCustomerFixable({ status: 429 })).toBe(true);
    expect(isCustomerFixable({ status: 409, nonJson: true })).toBe(false); // a proxy page, not the backend
    expect(isCustomerFixable({ status: 500 })).toBe(false);
    expect(isCustomerFixable({ status: 502, nonJson: true })).toBe(false);
    expect(isCustomerFixable({ networkCode: 'ETIMEDOUT', networkError: true })).toBe(false);
  });

  it('uses the levels at the call site and never logs personal data', () => {
    const handler = source.slice(source.indexOf("ipcMain.handle('auth:register'"), source.indexOf('function isCustomerFixableRegisterRefusal'));
    expect(handler).toMatch(/if \(isCustomerFixableRegisterRefusal\(failure\)\) log\.info\(line\);\s*else log\.warn\(line\);/);
    const line = /const line = `[^`]*`/.exec(handler)?.[0] || '';
    expect(line).not.toMatch(/email|password|name\b/);
  });
});
