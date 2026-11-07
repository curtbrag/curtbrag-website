import test from 'node:test';
import assert from 'node:assert/strict';
import { handler } from '../netlify/functions/chat.js';

test('fallback describes the current fleet and directs live status to the dashboard', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    for (const message of ['Tell me about the compute cluster', 'What is the phone cluster?']) {
      const response = await handler({httpMethod:'POST',headers:{},body:JSON.stringify({message})});
      const body = JSON.parse(response.body);
      assert.equal(body.powered_by, 'fallback');
      assert.match(body.reply, /eight Android\/Termux phones/);
      assert.match(body.reply, /four Linux systems and one Windows workstation/);
      assert.match(body.reply, /\/cluster\/dashboard\//);
      assert.doesNotMatch(body.reply, /Kubernetes|K3s|running pods|10 OnePlus|all.*online/i);
    }
    const contact = JSON.parse((await handler({httpMethod:'POST',headers:{},body:JSON.stringify({message:'What is the contact phone number?'})})).body);
    assert.match(contact.reply, /781-417-0692/);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('all six homepage shortcuts have useful fallback answers and specific intents beat generic tool matching', async () => {
  const saved=process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const cases=[
      ['Schedule a stop',/schedule a truck stop/i],
      ['What promos are running?',/don’t have a verified list/],
      ['How do I pay?',/Quick Pay.*\/zelle\//],
      ['I need warranty help',/\/contact\/\?subject=Warranty%20help/],
      ['How do I contact Curt?',/781-417-0692/],
      ['Tell me a joke',/turning things around/],
      ['Warranty for a socket wrench',/eligibility/],
      ['How do I pay for tools?',/Quick Pay/],
      ['Snap-on tool promotions',/verified list/]
    ];
    for(const [message,expected] of cases){
      const response=await handler({httpMethod:'POST',headers:{},body:JSON.stringify({message})});
      const body=JSON.parse(response.body);
      assert.equal(body.powered_by,'fallback');
      assert.match(body.reply,expected,message);
      assert.doesNotMatch(body.reply,/trouble connecting/i,message);
    }
  } finally {
    if(saved===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=saved;
  }
});
