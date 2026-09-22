import assert from 'node:assert/strict';
import { register } from 'node:module';
register('../../riverscape/tests/three-loader.mjs', import.meta.url);
const THREE=await import('three');
const { ReefSimulation, FIXED_STEP, POPULATION_RANGE }=await import('../src/simulation.js');
const { createFishSchool }=await import('../src/fish-model.js');

// Fish join and leave the running tank. Leavers come off the bottom of each hierarchy,
// so the breeding clownfish, the nest-holding chromis and the male anthias stay.
const sim=new ReefSimulation(),scene=new THREE.Scene(),school=createFishSchool(scene,sim);
const run=seconds=>{for(let i=0;i<seconds/FIXED_STEP;i++)sim.step(FIXED_STEP);school.update();};
const kind=k=>sim.fish.filter(f=>f.kind===k);
const drawn=k=>school.groups.find(g=>g.kind===k).mesh.count;
run(3);

const female=kind('clown').find(f=>f.rank===0),nest=kind('chromis').find(f=>f.rank===0),male=kind('anthias').find(f=>f.rank===0);
assert.equal(sim.setPopulation({clownfish:2,chromis:3,anthias:1}),true);
assert.equal(sim.fish.length,6);assert.equal(sim.previous.length,6);
assert.ok(kind('clown').includes(female)&&kind('chromis').includes(nest)&&kind('anthias').includes(male),'The top of each hierarchy stays');
for(const f of sim.fish)assert.ok(!f.follow||sim.fish.includes(f.follow),'No one follows a fish that left');
run(3);
assert.equal(drawn('clown'),2);assert.equal(drawn('chromis'),3);assert.equal(drawn('anthias'),1);

assert.equal(sim.setPopulation({clownfish:4,chromis:18,anthias:14}),true);
assert.deepEqual(kind('clown').map(f=>f.rank).sort(),[0,1,2,3]);
assert.equal(sim.previous.length,sim.fish.length);
const [first,,,fourth]=[...kind('clown')].sort((a,b)=>a.rank-b.rank);
assert.ok(first.size/fourth.size>2,'A fourth clownfish joins at the bottom of the size ladder');
run(10);
assert.equal(drawn('chromis'),18);assert.equal(drawn('anthias'),14);
for(const f of sim.fish)assert.ok(Number.isFinite(f.position.x+f.position.y+f.position.z),'Positions stay finite');

assert.equal(sim.setPopulation({clownfish:4,chromis:18,anthias:14}),false,'No change is no change');
sim.setPopulation({clownfish:99,chromis:-3});
assert.equal(kind('clown').length,POPULATION_RANGE.clownfish[1]);assert.equal(kind('chromis').length,0);
run(2);assert.equal(drawn('chromis'),0);
assert.deepEqual({...sim.population,shrimp:undefined},{clownfish:4,chromis:0,anthias:14,shrimp:undefined});

console.log('PASS: reef restocked 3/9/7 -> 2/3/1 -> 4/18/14 -> 4/0/14 in place, hierarchies kept');
