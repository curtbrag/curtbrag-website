import test from 'node:test';
import assert from 'node:assert/strict';
for(const name of ['chat','cluster-jobs','cluster-status']){
  test(name+' loads as an ES module and exports the legacy HTTP handler',async()=>{
    const module=await import('../netlify/functions/'+name+'.js');
    assert.equal(typeof module.handler,'function');
  });
}
