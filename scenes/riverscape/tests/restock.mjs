import { register } from "node:module";
import assert from "node:assert/strict";

register("./three-loader.mjs", import.meta.url);
const THREE = await import("three");
const { BOUNDS, COUNT, COUNT_RANGE, createFishSchool } = await import("../src/fish.js");
const { THICKETS } = await import("../src/plants.js");

// The school grows and shrinks while it swims: no rebuild, the instance slots stay
// 0..n-1, and newcomers join from a side of the tank and swim in.
const STEP = 1 / 60;
const scene = new THREE.Scene();
const school = createFishSchool(scene, { thickets: THICKETS });
const [bodies, membranes] = scene.children.filter((child) => child.isInstancedMesh);
let time = 0;
const run = (seconds) => {
  for (let i = 0; i < seconds / STEP; i++) school.update(STEP, (time += STEP), null);
};
const ids = () => school.fish.map((f) => f.id).join();
const slots = (n) => Array.from({ length: n }, (_, i) => i).join();

assert.equal(bodies.count, COUNT);
run(5);
const survivor = school.fish[3];
school.setCount(10);
assert.equal(school.fish.length, 10);
assert.equal(bodies.count, 10);
assert.equal(membranes.count, 10);
assert.equal(ids(), slots(10));
assert.equal(school.fish[3], survivor, "Leavers go from the end");
for (const f of school.fish) assert.ok(!f.recruiter || school.fish.includes(f.recruiter), "No one follows a fish that left");
run(5);

school.setCount(40);
assert.equal(ids(), slots(40));
assert.equal(bodies.count, 40);
const newcomers = school.fish.slice(10);
for (const f of newcomers) assert.ok(Math.abs(f.position.x) > BOUNDS.maxX - 1, "Newcomers start at a side");
run(20);
const inside = newcomers.filter((f) => Math.abs(f.position.x) < BOUNDS.maxX - 1.5).length;
assert.ok(inside >= newcomers.length * 0.6, `${inside}/${newcomers.length} newcomers swam in`);
for (const f of school.fish) {
  assert.ok(Number.isFinite(f.position.x + f.position.y + f.position.z), "Positions stay finite");
}

school.setCount(999);
assert.equal(school.fish.length, COUNT_RANGE[1]);
school.setCount(-5);
assert.equal(school.fish.length, COUNT_RANGE[0]);
run(2);
assert.equal(school.getTelemetry().count, COUNT_RANGE[0]);

console.log(`PASS: school restocked 24 -> 10 -> 40 -> ${COUNT_RANGE[1]} -> ${COUNT_RANGE[0]} in place; ${inside}/30 newcomers swam in within 20 s`);
