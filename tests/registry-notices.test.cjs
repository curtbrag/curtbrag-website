const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('public/scripts/cluster-swarm-live-v8.js','utf8');
const start=source.indexOf('  function ensureRegistryNotices(');
const end=source.indexOf('  function ensureAdminNavigation()',start);

test('registry panels retain their records and route operators to the current workspace',()=>{
  const nodes=new Map(),buttons=new Map(),navigation=[];
  class Element {
    constructor(){this.children=[];this.textContent='';}
    set id(value){this._id=value;nodes.set(value,this);}
    get id(){return this._id;}
    append(...items){this.children.push(...items);}
    prepend(item){this.children.unshift(item);}
  }
  for(const id of ['fleet','devices','analytics','jobs']){
    const panel=new Element();panel.id='tab-'+id;panel.append({records:'existing data'});
    buttons.set(id,new Element());
  }
  const context={document:{createElement:()=>new Element(),getElementById:id=>nodes.get(id),querySelector:selector=>buttons.get(selector.match(/data-tab="([^"]+)"/)[1])},setControlView:(view,focus)=>navigation.push({view,focus})};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  let workspaceClicks=0;const work={click:()=>workspaceClicks++};
  context.ensureRegistryNotices(work);context.ensureRegistryNotices(work);
  assert.equal(buttons.get('fleet').textContent,'Registry overview');
  assert.equal(buttons.get('jobs').textContent,'Legacy jobs');
  for(const id of ['fleet','devices','analytics','jobs']){
    const panel=nodes.get('tab-'+id);
    assert.equal(panel.children.length,2,'Repeated initialization must not duplicate notices');
    assert.equal(panel.children[1].records,'existing data','Historical data must be retained');
    const note=panel.children[0];
    assert.match(note.children.map(child=>child.textContent).join(' '),/older|legacy/i);
    note.children[2].onclick();
  }
  assert.equal(workspaceClicks,4);
  assert.deepEqual(navigation.map(x=>x.view),['fleet','fleet','fleet','media']);
  assert.ok(navigation.every(x=>x.focus===true));
});
