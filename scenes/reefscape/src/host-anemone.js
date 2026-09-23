import * as THREE from 'three';
import { GLTFLoader } from '../../../vendor/addons/loaders/GLTFLoader.js';
import { underwater, responseAt } from './water.js';
import { HOST } from './layout.js';
import { supportHeight } from './terrain.js';
import { GAIT } from './simulation.js';

// The clownfish host is the rigged model 3d_models/build_anemone.py builds, exported to
// assets/host-anemone.glb. Blender supplies the mesh and the bones and nothing else: every
// movement is made here, the one worked out in docs/anemone_preview.html. The base stays
// still while each tentacle rolls through a travelling wave; on top of that the crown
// leans with the pump current and pulls in when the clownfish bolt for it. A contact pass
// keeps the packed tentacles from passing through each other, and parts them around a
// clownfish bathing in the crown.
const SCALE=.9;   // the model's crown reaches 1.39; this fits it to HOST.radius
const DISC=.50;   // model height of the oral disc's centre above the pedal disc
// The stub stands in a crevice. Its pedal disc is pushed this far further down, hidden in
// the rock, so where the shoulder falls away the column runs on into it instead of floating.
const SINK=.40;

const clamp01=value=>Math.max(0,Math.min(1,value));
const ease=value=>{const t=clamp01(value);return t*t*(3-2*t);};
const stableUnit=index=>{const value=Math.sin((index+1)*127.1+311.7)*43758.5453;return value-Math.floor(value);};

// Neighbouring tentacles must move nearly together or they pass through each other, so
// the wave's phase comes from where a tentacle sits on the disc (a wave rolling across the
// crown) plus a small per-tentacle jitter.
const FLOW_DIR={x:.8,z:.6},WAVE_NUMBER=3.2,PHASE_JITTER=.5,PLANE_PHASE=1.2;
const WAVE_SPEED=.9,WAVE_INTENSITY=.75;
const REACH=[.56,.72,.88,1];   // share of each joint's bend, root to tip
function makeWave(index,x,z){
  return {phase:(x*FLOW_DIR.x+z*FLOW_DIR.z)*WAVE_NUMBER+(stableUnit(index+1300)-.5)*PHASE_JITTER,
    planePhase:PLANE_PHASE+(stableUnit(index+2300)-.5)*PHASE_JITTER,
    curlGain:.9+stableUnit(index+3300)*.2,swingGain:.65+stableUnit(index+4300)*.35};
}
const wave={curl:0,swing:0};
function waveAt(group,t,jointPhase){
  const phase=t*WAVE_SPEED+group.phase-jointPhase,harmonic=phase*2+group.phase*.25;
  wave.curl=(.42*Math.sin(phase)+.08*Math.sin(harmonic))*group.curlGain*WAVE_INTENSITY;
  wave.swing=(.10*Math.sin(phase+group.planePhase)+.025*Math.sin(harmonic+group.planePhase))*group.swingGain*WAVE_INTENSITY;
  return wave;
}
// The pump's slow response at the disc bends the whole crown downstream: radians per unit
// of flow at each joint. Long tentacles lag the pump by about a second.
const FLOW_LEAN=.3,FLOW_TAU=1.1;
// A fresh alarm on a clownfish near the host is a hand at the glass: the crown snaps in,
// holds, then takes twenty seconds to reopen, as a real anemone does.
const STARTLE_CLOSE=1.25,STARTLE_HOLD=.75,STARTLE_REOPEN=20,ALARM_FRESH=2.0;
const POSE_SMOOTHING=.25;   // seconds; joints ease toward their target so nothing jumps
// Contact solver: each tentacle is a chain of capsules; wherever two overlap by more than
// they already do in the modelled rest pose, both are nudged apart through small curl and
// swing corrections that fade once the contact clears. Clownfish are capsules too, and
// only the tentacle gives way.
const CONTACT_TOLERANCE=.003,FIX_RELAX=.6,FIX_LIMIT=.9;
// A contact close to a joint has almost no lever on it, and the plain minimum-norm answer
// swings that joint to its limit in one frame and back in the next. Damping the solve
// (squared lever, tank units²) and capping how fast a correction may change (radians per
// second) spreads a hard push over a few frames instead.
const FIX_DAMPING=.03,FIX_RATE=1.2;
const CONTACT_ITERATIONS={eco:2,balanced:3,detail:6,ultra:8};

// Ericson, Real-Time Collision Detection 5.1.9: closest points of segments p1q1 and p2q2.
const closest={s:0,t:0,distance:0};
function closestSegments(p1,q1,p2,q2){
  const d1x=q1.x-p1.x,d1y=q1.y-p1.y,d1z=q1.z-p1.z,d2x=q2.x-p2.x,d2y=q2.y-p2.y,d2z=q2.z-p2.z;
  const rx=p1.x-p2.x,ry=p1.y-p2.y,rz=p1.z-p2.z;
  const a=d1x*d1x+d1y*d1y+d1z*d1z,e=d2x*d2x+d2y*d2y+d2z*d2z,b=d1x*d2x+d1y*d2y+d1z*d2z,c=d1x*rx+d1y*ry+d1z*rz,f=d2x*rx+d2y*ry+d2z*rz;
  const denom=a*e-b*b;let s=denom>1e-12?clamp01((b*f-c*e)/denom):0,t=(b*s+f)/e;
  if(t<0){t=0;s=clamp01(-c/a);}else if(t>1){t=1;s=clamp01((b-c)/a);}
  const x=rx+d1x*s-d2x*t,y=ry+d1y*s-d2y*t,z=rz+d1z*s-d2z*t;
  closest.s=s;closest.t=t;closest.distance=Math.sqrt(x*x+y*y+z*z);
}

// The disc sits on HOST with the same lean-and-slope frame the procedural specimens use.
export function hostFrame(){
  const step=.25,lean=HOST.lean||[0,0];
  const slopeX=(supportHeight(HOST.x+step,HOST.z)-supportHeight(HOST.x-step,HOST.z))/(2*step),slopeZ=(supportHeight(HOST.x,HOST.z+step)-supportHeight(HOST.x,HOST.z-step))/(2*step);
  const axis=new THREE.Vector3(-slopeX*.35+lean[0],1,-slopeZ*.35+lean[1]).normalize();
  const quaternion=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),axis);
  const foot=new THREE.Vector3(HOST.x,HOST.y,HOST.z).addScaledVector(axis,-DISC*SCALE);
  return {axis,quaternion,foot};
}

async function loadModel(data){
  if(!data){
    const response=await fetch(new URL('../assets/host-anemone.glb',import.meta.url));
    if(!response.ok&&response.status!==0)throw new Error('Unable to load the host anemone.');
    data=await response.arrayBuffer();
  }
  return new GLTFLoader().parseAsync(data,'');
}

// `data` is the GLB's bytes; the scene fetches them, the tests read them from disk.
export async function createHostAnemone(scene,simulation,data){
  const gltf=await loadModel(data),model=gltf.scene;
  model.getObjectByName('Cube')?.removeFromParent();   // an export stray, not part of the rig
  const body=model.getObjectByName('Anemone_Body'),tentacles=model.getObjectByName('Anemone_Tentacles');
  if(!body?.isSkinnedMesh||!tentacles?.isSkinnedMesh)throw new Error('Invalid host anemone asset.');

  {const position=body.geometry.attributes.position;
    for(let i=0;i<position.count;i++)if(position.getY(i)<.005)position.setY(i,position.getY(i)-SINK);}
  // Per-vertex axial parameter (glTF flips V, so the root is 1) and ring for the shader.
  const skinIndex=tentacles.geometry.attributes.skinIndex,skinWeight=tentacles.geometry.attributes.skinWeight;
  const uv=tentacles.geometry.attributes.uv,count=uv.count,axial=new Float32Array(count),ring=new Float32Array(count);
  for(let i=0;i<count;i++)axial[i]=1-uv.getY(i);
  tentacles.geometry.setAttribute('aAxis',new THREE.BufferAttribute(axial,1));

  body.material=underwater(new THREE.MeshStandardMaterial({vertexColors:true,roughness:.55}),{key:'host-anemone-body',transmission:.10});
  tentacles.material=underwater(new THREE.MeshStandardMaterial({vertexColors:true,roughness:.45}),{
    key:'host-anemone-tentacles',
    vertex:'attribute float aAxis;attribute float aRing;varying float vAxis;varying float vRing;',
    begin:'vAxis=aAxis;vRing=aRing;',
    fragment:'varying float vAxis;varying float vRing;',
    // Tissue a few cells thick: the base passes a little light, the tip most of it.
    transmission:'(.20+.40*smoothstep(.20,1.,vAxis))',
    // Light through the thin edge of a tentacle: where the surface turns away from the eye
    // the tissue goes pale and warm instead of dark.
    surfaceNormal:`float thin=smoothstep(.30,.95,vAxis),rim=pow(1.-abs(dot(normal,normalize(vViewPosition))),2.5);
      diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.62,.52,.34),rim*thin*.25);roughnessFactor*=1.-.10*thin;`,
    // The model's colours are picked under Blender's light; the reef lamp is far stronger,
    // and kept at full strength the gold shafts wash out to cream. Inside the crown the
    // roots and the inner rings' shafts are buried among their neighbours, and what light
    // reaches them has come through tissue: they go deep amber.
    color:`diffuseColor.rgb*=vec3(.62,.56,.40);
      float buried=(1.-smoothstep(.10,.60,vAxis))*(1.-.60*vRing*vRing);diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.42,.28,.14),buried*.70);`,
  });

  // The tentacle chains, named tentacle.NNN.01–04. GLTFLoader strips the dots from
  // object.name; the original glTF name lives in userData.name.
  const groups=[];let boneSeed=1;
  model.traverse(object=>{
    if(!object.isBone)return;
    const match=(object.userData.name??object.name).match(/^tentacle\.(\d+)\.(\d+)$/),seed=boneSeed++;
    if(!match)return;
    const index=Number(match[1]),joint=Number(match[2])-1;
    const group=groups[index]??=({...makeWave(index,object.position.x,object.position.z),index,bones:[]});
    group.bones[joint]={bone:object,rest:{quaternion:object.quaternion.clone(),scale:object.scale.clone()},
      jointPhase:joint*1.45+(stableUnit(seed+21)-.5)*.08,curl:0,swing:0,fixCurl:0,fixSwing:0,fromCurl:0,fromSwing:0,gainCurl:0,gainSwing:0};
  });
  for(let i=groups.length-1;i>=0;i--)if(!groups[i]||groups[i].bones.length!==4)groups.splice(i,1);

  const frame=hostFrame(),host=new THREE.Group();
  host.position.copy(frame.foot);host.quaternion.copy(frame.quaternion);host.scale.setScalar(SCALE);host.add(model);
  scene.add(host);host.updateMatrixWorld(true);
  for(const mesh of [body,tentacles]){mesh.frustumCulled=false;mesh.receiveShadow=true;}
  // The body is baked into the static shadow map in its rest pose; the column barely moves.
  body.castShadow=true;tentacles.castShadow=false;

  const X=new THREE.Vector3(),Y=new THREE.Vector3(),Z=new THREE.Vector3(),cp=new THREE.Vector3(),cq=new THREE.Vector3();
  const normal=new THREE.Vector3(),axis=new THREE.Vector3(),lever=new THREE.Vector3(),tipOffset=new THREE.Vector3();
  const qx=new THREE.Quaternion(),qz=new THREE.Quaternion(),qDelta=new THREE.Quaternion();
  // Per tentacle: its 4 joint pivots and tip in the tank, and the boxes around each capsule
  // (6 floats apiece, radius included) followed by the box around all four.
  const contactPoints=[],contactBoxes=[];let contactAllowed=null;

  function poseJoint(entry){
    qx.setFromAxisAngle(X.set(1,0,0),entry.curl+entry.fixCurl);qz.setFromAxisAngle(Z.set(0,0,1),entry.swing+entry.fixSwing);
    entry.bone.quaternion.copy(entry.rest.quaternion).multiply(qDelta.copy(qx).multiply(qz));
  }
  function updateContactPoints(){
    for(let i=0;i<groups.length;i++){
      const {bones,tip,radius}=groups[i],points=contactPoints[i],box=contactBoxes[i];
      for(let k=0;k<4;k++)points[k].setFromMatrixPosition(bones[k].bone.matrixWorld);
      points[4].copy(tipOffset.set(0,tip,0)).applyMatrix4(bones[3].bone.matrixWorld);
      box.fill(Infinity,24,27).fill(-Infinity,27,30);
      for(let k=0;k<4;k++){
        const a=points[k],b=points[k+1],r=radius[k],o=k*6;
        box[o]=Math.min(a.x,b.x)-r;box[o+1]=Math.min(a.y,b.y)-r;box[o+2]=Math.min(a.z,b.z)-r;
        box[o+3]=Math.max(a.x,b.x)+r;box[o+4]=Math.max(a.y,b.y)+r;box[o+5]=Math.max(a.z,b.z)+r;
        for(let c=0;c<3;c++){box[24+c]=Math.min(box[24+c],box[o+c]);box[27+c]=Math.max(box[27+c],box[o+3+c]);}
      }
    }
  }
  const apart=(a,o,b,q)=>a[o]>b[q+3]||b[q]>a[o+3]||a[o+1]>b[q+4]||b[q+1]>a[o+4]||a[o+2]>b[q+5]||b[q+2]>a[o+5];
  // Visits every capsule pair from different tentacles whose boxes touch; the rest are too
  // far apart to overlap, and the exact test is most of the solver's cost.
  function forEachContact(visit){
    const n=groups.length;
    for(let i=0;i<n;i++){const a=contactBoxes[i];
      for(let j=i+1;j<n;j++){const b=contactBoxes[j];
        if(apart(a,24,b,24))continue;
        const pi=contactPoints[i],pj=contactPoints[j];
        for(let si=0;si<4;si++)for(let sj=0;sj<4;sj++){
          if(si===0&&sj===0)continue;   // the bases share the disc
          if(apart(a,si*6,b,sj*6))continue;
          closestSegments(pi[si],pi[si+1],pj[sj],pj[sj+1]);
          visit(i,j,si,sj,groups[i].radius[si]+groups[j].radius[sj]-closest.distance,(i*n+j)*16+si*4+sj);
        }}}
  }
  // Moves the contact point on segment `segment` of tentacle `index` by `amount` along
  // `normal`, with the minimum-norm change to the curl and swing of that joint and the
  // joints below it.
  function nudge(index,segment,contact,amount){
    const {bones}=groups[index];let total=0;
    for(let k=0;k<=segment;k++){
      const e=bones[k].bone.matrixWorld.elements;lever.subVectors(contact,contactPoints[index][k]);
      bones[k].gainCurl=axis.set(e[0],e[1],e[2]).normalize().cross(lever).dot(normal);
      bones[k].gainSwing=axis.set(e[8],e[9],e[10]).normalize().cross(lever).dot(normal);
      total+=bones[k].gainCurl**2+bones[k].gainSwing**2;
    }
    const scale=amount/(total+FIX_DAMPING);
    for(let k=0;k<=segment;k++){const entry=bones[k];
      entry.fixCurl=Math.max(-FIX_LIMIT,Math.min(FIX_LIMIT,entry.fixCurl+entry.gainCurl*scale));
      entry.fixSwing=Math.max(-FIX_LIMIT,Math.min(FIX_LIMIT,entry.fixSwing+entry.gainSwing*scale));}
  }
  // Clownfish near enough to touch the crown, as capsules along their heading.
  const fishCapsules=Array.from({length:6},()=>({p:new THREE.Vector3(),q:new THREE.Vector3(),radius:0,box:new Float32Array(6)}));let fishCount=0;
  function resolveContacts(iterations){
    for(let iteration=0;iteration<iterations;iteration++){
      for(const group of groups)group.bones[0].bone.updateMatrixWorld(true);
      updateContactPoints();let moved=false;
      forEachContact((i,j,si,sj,overlap,slot)=>{
        const excess=overlap-contactAllowed[slot];if(excess<=0)return;
        const pi=contactPoints[i],pj=contactPoints[j];
        cp.lerpVectors(pi[si],pi[si+1],closest.s);cq.lerpVectors(pj[sj],pj[sj+1],closest.t);
        normal.subVectors(cp,cq);if(normal.lengthSq()<1e-10)normal.set(pi[0].x-pj[0].x,0,pi[0].z-pj[0].z);normal.normalize();
        nudge(i,si,cp,excess*.5);normal.negate();nudge(j,sj,cq,excess*.5);
        if(excess>CONTACT_TOLERANCE)moved=true;
      });
      for(let f=0;f<fishCount;f++){const fish=fishCapsules[f];
        for(let i=0;i<groups.length;i++){const box=contactBoxes[i];
          if(apart(fish.box,0,box,24))continue;
          const points=contactPoints[i];
          for(let si=1;si<4;si++){
            if(apart(fish.box,0,box,si*6))continue;
            closestSegments(points[si],points[si+1],fish.p,fish.q);
            const excess=groups[i].radius[si]+fish.radius-closest.distance;if(excess<=0)continue;
            cp.lerpVectors(points[si],points[si+1],closest.s);cq.lerpVectors(fish.p,fish.q,closest.t);
            normal.subVectors(cp,cq);if(normal.lengthSq()<1e-10)continue;normal.normalize();
            nudge(i,si,cp,excess);if(excess>CONTACT_TOLERANCE)moved=true;
          }
        }}
      if(!moved)break;
      for(const group of groups)for(const entry of group.bones)poseJoint(entry);
    }
  }

  // Capsule sizes from the skinned mesh, the overlap each capsule pair already has in the
  // rest pose (which the solver leaves alone), and each tentacle's outward and sideways
  // directions in the tank, for the current and the fish to push along.
  {
    const slotOf=new Map();groups.forEach((group,i)=>group.bones.forEach((entry,k)=>slotOf.set(entry.bone,i*4+k)));
    const inverse=groups.flatMap(group=>group.bones.map(entry=>entry.bone.matrixWorld.clone().invert()));
    const samples=groups.flatMap(()=>[[],[],[],[]]),tips=groups.map(()=>0),vertex=new THREE.Vector3();
    for(let v=0;v<count;v++){
      let joint=0,weight=-1;
      for(let c=0;c<4;c++)if(skinWeight.getComponent(v,c)>weight){weight=skinWeight.getComponent(v,c);joint=skinIndex.getComponent(v,c);}
      const slot=slotOf.get(tentacles.skeleton.bones[joint]);if(slot===undefined)continue;
      tentacles.getVertexPosition(v,vertex).applyMatrix4(tentacles.matrixWorld).applyMatrix4(inverse[slot]);
      samples[slot].push(Math.hypot(vertex.x,vertex.z));
      if(slot%4===3)tips[slot>>2]=Math.max(tips[slot>>2],vertex.y);
    }
    const worldScale=new THREE.Vector3().setFromMatrixScale(groups[0].bones[0].bone.matrixWorld).x;
    const centre=new THREE.Vector3(HOST.x,HOST.y,HOST.z),root=new THREE.Vector3(),tip=new THREE.Vector3(),span=new THREE.Vector3();
    let outermost=0;
    groups.forEach((group,i)=>{
      group.tip=tips[i];
      // Median: the tube, not the flared base.
      group.radius=[0,1,2,3].map(k=>{const values=samples[i*4+k].sort((a,b)=>a-b);return values[values.length>>1]*worldScale;});
      contactPoints.push(Array.from({length:5},()=>new THREE.Vector3()));contactBoxes.push(new Float32Array(30));
      const base=group.bones[0].bone.matrixWorld;
      root.setFromMatrixPosition(base);tip.set(0,group.tip,0).applyMatrix4(group.bones[3].bone.matrixWorld);span.subVectors(tip,root);
      group.radial=new THREE.Vector3(root.x-centre.x,0,root.z-centre.z).normalize();
      group.tangent=new THREE.Vector3(-group.radial.z,0,group.radial.x);
      group.distance=Math.hypot(root.x-centre.x,root.z-centre.z);outermost=Math.max(outermost,group.distance);
      // Which way a positive curl and swing carry the tip, read off the rig rather than assumed.
      group.curlSign=Math.sign(axis.setFromMatrixColumn(base,0).cross(span).dot(group.radial))||1;
      group.swingSign=Math.sign(axis.setFromMatrixColumn(base,2).cross(span).dot(group.tangent))||1;
    });
    groups.forEach(group=>{group.ring=group.distance/outermost;});
    for(let v=0;v<count;v++){
      let joint=0,weight=-1;
      for(let c=0;c<4;c++)if(skinWeight.getComponent(v,c)>weight){weight=skinWeight.getComponent(v,c);joint=skinIndex.getComponent(v,c);}
      const slot=slotOf.get(tentacles.skeleton.bones[joint]);ring[v]=slot===undefined?1:groups[slot>>2].ring;
    }
    tentacles.geometry.setAttribute('aRing',new THREE.BufferAttribute(ring,1));
    updateContactPoints();
    contactAllowed=new Float32Array(groups.length*groups.length*16);
    forEachContact((i,j,si,sj,overlap,slot)=>{contactAllowed[slot]=Math.max(0,overlap);});
  }

  let iterations=CONTACT_ITERATIONS.balanced,posed=false,startleAt=-Infinity,shownContraction=0;
  const centre=new THREE.Vector3(HOST.x,HOST.y,HOST.z),flow=new THREE.Vector3(),heading=new THREE.Vector3();
  const nearby=(HOST.radius+1)**2;
  function contraction(t){
    const age=t-startleAt;
    if(age<STARTLE_CLOSE)return ease(age/STARTLE_CLOSE);
    if(age<STARTLE_CLOSE+STARTLE_HOLD)return 1;
    return 1-ease((age-STARTLE_CLOSE-STARTLE_HOLD)/STARTLE_REOPEN);
  }
  // Poses the rig for simulation.time. dt is the simulated time since the last pose; the
  // first pose, and any jump (a capture, an advance), settles straight onto its targets.
  function update(dt){
    if(posed&&dt<=0)return;
    const t=simulation.time,snap=!posed||dt>.5;posed=true;
    const follow=snap?1:1-Math.exp(-dt/POSE_SMOOTHING),relax=snap?0:Math.exp(-dt/FIX_RELAX);

    fishCount=0;
    for(const f of simulation.fish){
      if(f.kind!=='clown'||f.position.distanceToSquared(centre)>nearby)continue;
      if(f.alarm>ALARM_FRESH&&t-startleAt>STARTLE_CLOSE)startleAt=t-STARTLE_CLOSE*contraction(t);
      if(fishCount===fishCapsules.length)continue;
      const capsule=fishCapsules[fishCount++],length=GAIT.clown.length*f.size;
      heading.set(Math.cos(f.yaw),0,-Math.sin(f.yaw));
      capsule.p.copy(f.position).addScaledVector(heading,length*.40);capsule.q.copy(f.position).addScaledVector(heading,-length*.35);
      capsule.radius=length*.16;
      const {p,q,radius,box}=capsule;
      box[0]=Math.min(p.x,q.x)-radius;box[1]=Math.min(p.y,q.y)-radius;box[2]=Math.min(p.z,q.z)-radius;
      box[3]=Math.max(p.x,q.x)+radius;box[4]=Math.max(p.y,q.y)+radius;box[5]=Math.max(p.z,q.z)+radius;
    }
    const contract=contraction(t);shownContraction+=(contract-shownContraction)*follow;
    responseAt(centre,t,FLOW_TAU,flow);flow.y=0;

    for(const group of groups){
      const leanCurl=FLOW_LEAN*flow.dot(group.radial)*group.curlSign,leanSwing=FLOW_LEAN*flow.dot(group.tangent)*group.swingSign;
      for(let joint=0;joint<4;joint++){
        const entry=group.bones[joint],reach=REACH[joint],w=waveAt(group,t,entry.jointPhase);
        const curlTarget=(w.curl+leanCurl-.38*contract)*reach,swingTarget=(w.swing+leanSwing)*reach*(1-.4*contract);
        entry.curl+=(curlTarget-entry.curl)*follow;entry.swing+=(swingTarget-entry.swing)*follow;
        entry.fixCurl*=relax;entry.fixSwing*=relax;entry.fromCurl=entry.fixCurl;entry.fromSwing=entry.fixSwing;
        entry.bone.scale.copy(entry.rest.scale);entry.bone.scale.y*=1-.08*shownContraction;
        poseJoint(entry);
      }
    }
    resolveContacts(snap?CONTACT_ITERATIONS.detail:iterations);
    if(snap)return;
    const step=FIX_RATE*dt;
    for(const group of groups)for(const entry of group.bones){
      entry.fixCurl=Math.max(entry.fromCurl-step,Math.min(entry.fromCurl+step,entry.fixCurl));
      entry.fixSwing=Math.max(entry.fromSwing-step,Math.min(entry.fromSwing+step,entry.fixSwing));
      poseJoint(entry);
    }
  }
  return {
    body,tentacles,bones:tentacles.skeleton.bones.length,count:groups.length,update,
    setQuality(quality){iterations=CONTACT_ITERATIONS[quality]??CONTACT_ITERATIONS.balanced;},
    get contraction(){return shownContraction;},
    // The deepest a tentacle now sinks into another (beyond their rest-pose overlap) and
    // into a clownfish.
    penetration(){
      for(const group of groups)group.bones[0].bone.updateMatrixWorld(true);
      updateContactPoints();let tentacle=0,fish=0;
      forEachContact((i,j,si,sj,overlap,slot)=>{tentacle=Math.max(tentacle,overlap-contactAllowed[slot]);});
      for(let f=0;f<fishCount;f++)for(let i=0;i<groups.length;i++)for(let si=1;si<4;si++){
        const {p,q,radius}=fishCapsules[f],points=contactPoints[i];
        closestSegments(points[si],points[si+1],p,q);fish=Math.max(fish,groups[i].radius[si]+radius-closest.distance);
      }
      return {tentacle,fish};
    },
  };
}
