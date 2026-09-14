import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/views/settings.js', import.meta.url), 'utf8');
for (const [mic, accessibility, expected] of [
  [true, {granted:true}, 'checked'],
  [false, {granted:true}, 'needsAttention'],
  [true, {status:'not_required'}, 'checked'],
  [null, {granted:true}, 'checkFailed'],
  [true, null, 'checkFailed'],
]) {
  test(`permission recheck reports ${expected} for ${JSON.stringify([mic,accessibility])}`, async () => {
    const match = source.match(/async function recheckPermissions\(\) \{[\s\S]*?\n\}/);
    assert.ok(match, 'explicit recheck handler exists');
    const button = {disabled:false, textContent:''};
    const feedback = {textContent:'', setAttribute(){}};
    let finish;
    let calls = 0;
    const pending = new Promise(resolve => {finish = resolve;});
    const context = vm.createContext({
      document:{getElementById:id=>id === 'recheckPermissions' ? button : feedback},
      translate:key=>key,
      currentSettings:{os:"macos"},
      checkMicrophonePermissionStatus:()=>{calls++; return pending.then(()=>mic);},
      checkAccessibilityStatus:()=>pending.then(()=>accessibility),
    });
    vm.runInContext(match[0],context);
    const result = vm.runInContext('recheckPermissions()',context);
    assert.equal(button.disabled,true);
    assert.equal(button.textContent,'settings.permission.checking');
    await vm.runInContext('recheckPermissions()',context);
    assert.equal(calls,1);
    finish();
    await result;
    assert.equal(button.disabled,false);
    assert.equal(feedback.textContent,`settings.permissions.${expected}`);
  });
}
