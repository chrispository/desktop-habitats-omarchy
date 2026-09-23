import assert from 'node:assert/strict';
import { register } from 'node:module';
register('../../riverscape/tests/three-loader.mjs',import.meta.url);
const { ANEMONES,HOST }=await import('../src/layout.js');
const { buildCrown,crownOrder,crownBudget }=await import('../src/anemone-crown.js');
const { createAnemone,TENTACLE_COUNT,SPECIMENS }=await import('../src/anemone.js');
const { createHostAnemone,hostFrame }=await import('../src/host-anemone.js');
const { ReefSimulation,FIXED_STEP }=await import('../src/simulation.js');
const THREE=await import('three');
import { readFile } from 'node:fs/promises';
let total=0;const summary=[];
assert.equal(ANEMONES[0],HOST);
for(let i=1;i<ANEMONES.length;i++){
  const crown=buildCrown(ANEMONES[i],i),{roots,S,rim,count,compact}=crown;total+=count;
  assert.equal(count,roots.length);
  assert.deepEqual(crown,buildCrown(ANEMONES[i],i),'Crown generation is deterministic');
  const order=crownOrder(roots);assert.equal(new Set(order).size,count);
  for(const a of roots){
    assert.ok(Object.values(a).every(Number.isFinite));
    assert.ok(a.radius>.20&&a.radius<=1,'Mouth stays bare and roots stay on the disc');
    assert.ok(a.length>0&&a.girth>0);
    if(compact){
      assert.ok(a.length/(2*rim*S)<.48,'Compact tentacles stay below half the disc diameter');
      assert.ok(a.tilt+a.curl<1.5,'Small crowns do not hook long tentacles below the oral disc');
      assert.ok(a.flex<.65,'Short tentacles are less compliant, not miniature streamers');
      for(const b of roots)if(a!==b){
        const d=Math.hypot(Math.cos(a.angle)*a.radius-Math.cos(b.angle)*b.radius,Math.sin(a.angle)*a.radius-Math.sin(b.angle)*b.radius)*rim*S;
        assert.ok(a.girth+b.girth<=d*.85+1e-9,'Tentacle roots must not intersect');
      }
    }
  }
  for(const quality of ['eco','balanced','detail']){
    const budget=crownBudget(crown,quality);
    assert.ok(budget<=count);if(compact)assert.ok(budget>=Math.min(count,36));
    const visible=order.slice(0,budget).map(j=>roots[j]);
    for(let sector=0;sector<6;sector++)assert.ok(visible.some(t=>Math.floor(((t.angle%(Math.PI*2)+Math.PI*2)%(Math.PI*2))/(Math.PI/3))===sector),'All angular sectors survive LOD');
  }
  summary.push({radius:ANEMONES[i].radius,count,compact,meanLength:roots.reduce((n,r)=>n+r.length,0)/count});
}
assert.equal(total,TENTACLE_COUNT);
const scene=new THREE.Scene(),anemone=createAnemone(scene);
for(const quality of ['detail','eco','balanced','detail']){
  anemone.setQuality(quality);
  assert.equal(anemone.tentacles.count,SPECIMENS.reduce((n,a,i)=>n+crownBudget(buildCrown(a,i+1),quality),0));
  for(const attribute of Object.values(anemone.tentacles.geometry.attributes))assert.ok([...attribute.array].every(Number.isFinite));
}
assert.equal(scene.children.length,2,'Still one tentacle draw plus one merged-body draw');

// The host: the rigged model, posed in code, with its oral disc on HOST.
const glb=await readFile(new URL('../assets/host-anemone.glb',import.meta.url));
const simulation=new ReefSimulation(7),hostScene=new THREE.Scene();
const host=await createHostAnemone(hostScene,simulation,glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength));
assert.equal(host.bones,389);assert.equal(host.count,96);
assert.equal(hostScene.getObjectByName('Cube'),undefined,'The export stray is dropped');
assert.ok(host.body.isSkinnedMesh&&host.tentacles.isSkinnedMesh&&host.body.skeleton===host.tentacles.skeleton,'Body and tentacles share one skeleton');
const disc=new THREE.Vector3();hostScene.getObjectByName('disc').getWorldPosition(disc);
const {axis,foot}=hostFrame();
assert.ok(disc.clone().sub(foot).normalize().dot(axis)>.999,'The disc bone stands on the host axis');
const quaternions=()=>host.tentacles.skeleton.bones.flatMap(b=>b.quaternion.toArray());
host.update(0);const rest=quaternions();assert.ok(rest.every(Number.isFinite));
host.update(0);assert.deepEqual(quaternions(),rest,'No simulated time, no motion');
let steps=0,moved=0;
for(;steps<600;steps++){simulation.step(FIXED_STEP);host.update(FIXED_STEP);}
const flowing=quaternions();assert.ok(flowing.every(Number.isFinite));
for(let i=0;i<rest.length;i++)moved=Math.max(moved,Math.abs(flowing[i]-rest[i]));
assert.ok(moved>.01,'The crown moves with the current');
// A clownfish bolting for the host shuts the crown; it reopens within half a minute.
const clown=simulation.fish.find(f=>f.kind==='clown');clown.position.set(HOST.x,HOST.y+.6,HOST.z);clown.alarm=2.6;
for(let i=0;i<150;i++){simulation.step(FIXED_STEP);host.update(FIXED_STEP);}
assert.ok(host.contraction>.8,'Startled crown pulls in');
for(let i=0;i<60*30;i++){simulation.step(FIXED_STEP);host.update(FIXED_STEP);}
assert.ok(host.contraction<.02,'Crown reopens');
assert.ok(quaternions().every(Number.isFinite));
// A cursor sweeping past alarms the clownfish, which dive into the crown as it shuts. The
// contact corrections must not snap tentacles about from one 30 fps frame to the next.
const tipBones=host.tentacles.skeleton.bones.filter(b=>/\.04$/.test(b.userData.name));
const tips=()=>{host.tentacles.skeleton.bones[0].updateMatrixWorld(true);return tipBones.map(b=>new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));};
let before=tips(),last=tips(),jerk=0;
for(let i=0;i<30*13;i++){
  const pointer=i<90?{position:new THREE.Vector3(HOST.x-3+i*.1,HOST.y+1,2.4),speed:5}:null;
  simulation.step(FIXED_STEP,pointer);simulation.step(FIXED_STEP,pointer);host.update(2*FIXED_STEP);
  const now=tips();for(let j=0;j<now.length;j++)jerk=Math.max(jerk,now[j].clone().sub(last[j]).sub(last[j]).add(before[j]).length());before=last;last=now;
}
assert.ok(jerk<.2,`Tentacle tips stay smooth through a startle (worst second difference ${jerk.toFixed(3)})`);
console.log(JSON.stringify({pass:true,total,anemones:summary,host:{bones:host.bones,tentacles:host.count,maxQuaternionDelta:moved,startleJerk:jerk}},null,2));
