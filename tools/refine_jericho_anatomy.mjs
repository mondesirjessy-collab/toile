#!/usr/bin/env node

/** Refine one rigged Jericho GLB without Blender.
 * Usage: node tools/refine_jericho_anatomy.mjs input.glb output.glb [--analyze]
 * The original BIN remains an exact prefix; only new POSITION/IBM accessors
 * and joint translations are authored. Normals, UV, indices, skin streams and
 * embedded images therefore remain byte-identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const analyze = args.includes('--analyze');
const positional = args.filter((a) => !a.startsWith('--'));
if (!positional[0]) throw new Error('usage: refine_jericho_anatomy.mjs source.glb [output.glb] [--analyze]');
const input = path.resolve(positional[0]);
const output = path.resolve(positional[1] ?? '/private/tmp/jericho-anatomy-refined.glb');
const reportPath = `${output}.report.json`;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const EXPECTED_SOURCE_SHA256 = '5de1d0e47684fe4035506df4b0315db6e8942b61523165a6b5bb9cf4803e641b';
const pad4 = (n) => (n + 3) & ~3;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);

function parseGlb(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0x46546c67 || v.getUint32(4, true) !== 2) throw new Error('GLB 2.0 requis');
  const jl = v.getUint32(12, true), jo = 20, bh = jo + jl;
  if (v.getUint32(16, true) !== 0x4e4f534a || v.getUint32(bh + 4, true) !== 0x004e4942) throw new Error('GLB embarque requis');
  const bl = v.getUint32(bh, true), bo = bh + 8;
  return { json: JSON.parse(bytes.subarray(jo, jo + jl).toString('utf8')), bin: bytes.subarray(bo, bo + bl) };
}
const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const sizes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
function accessor(parsed, index, normalized = false) {
  const a = parsed.json.accessors[index], bv = parsed.json.bufferViews[a.bufferView];
  if (!a || !bv || a.sparse || bv.byteStride) throw new Error(`accessor ${index} non compact`);
  const n = comps[a.type], size = sizes[a.componentType], off = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(parsed.bin.buffer, parsed.bin.byteOffset + off, a.count * n * size), out = new Float64Array(a.count * n);
  for (let i = 0; i < out.length; i++) {
    const o = i * size;
    let x = a.componentType === 5126 ? dv.getFloat32(o, true) : a.componentType === 5125 ? dv.getUint32(o, true) : a.componentType === 5123 ? dv.getUint16(o, true) : dv.getUint8(o);
    if (normalized && a.componentType === 5121) x /= 255;
    if (normalized && a.componentType === 5123) x /= 65535;
    out[i] = x;
  }
  return { values: out, bytes: parsed.bin.subarray(off, off + a.count * n * size), accessor: a };
}
const I = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; }
function inv(a) {
  const m = Array.from({ length: 4 }, (_, r) => [...Array.from({ length: 4 }, (_, c) => a[c * 4 + r]), ...Array.from({ length: 4 }, (_, c) => +(c === r))]);
  for (let c = 0; c < 4; c++) { let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r; [m[c], m[p]] = [m[p], m[c]]; const d = m[c][c]; if (Math.abs(d) < 1e-12) throw new Error('matrice singuliere'); for (let k = 0; k < 8; k++) m[c][k] /= d; for (let r = 0; r < 4; r++) if (r !== c) { const f = m[r][c]; for (let k = 0; k < 8; k++) m[r][k] -= f * m[c][k]; } }
  const o = new Float64Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = m[r][4 + c]; return o;
}
const point = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function nodeMatrix(n) {
  if (n.matrix) return Float64Array.from(n.matrix);
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return new Float64Array([(1 - 2 * (y*y + z*z))*sx,(2*(x*y+w*z))*sx,(2*(x*z-w*y))*sx,0,(2*(x*y-w*z))*sy,(1-2*(x*x+z*z))*sy,(2*(y*z+w*x))*sy,0,(2*(x*z+w*y))*sz,(2*(y*z-w*x))*sz,(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1]);
}
function parentsAndWorlds(nodes) {
  const parents = new Int32Array(nodes.length).fill(-1); nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parents[c] = i; }));
  const worlds = Array(nodes.length); const at = (i) => worlds[i] ??= parents[i] < 0 ? nodeMatrix(nodes[i]) : mul(at(parents[i]), nodeMatrix(nodes[i]));
  nodes.forEach((_, i) => at(i)); return { parents, worlds };
}
function canonicalizer(pos, height = 1.83) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pos[i+a]); hi[a] = Math.max(hi[a], pos[i+a]); }
  const s = height / (hi[1] - lo[1]), cx = (lo[0]+hi[0])/2, cz = (lo[2]+hi[2])/2;
  return { to: (p) => [-(p[0]-cx)*s,(p[1]-lo[1])*s,-(p[2]-cz)*s], from: (p) => [cx-p[0]/s,lo[1]+p[1]/s,cz-p[2]/s], normalFrom: (n) => [-n[0],n[1],-n[2]], scale: s };
}
function smoothCurve(y) {
  const c = [[0,1,1],[.44,1,1],[.533,1.035,1.04],[.655,1.12,1.16],[.755,1.12,1.16],[.79,1.035,1.06],[.878,1,1],[1,1,1]];
  const q = clamp(y / 1.83, 0, 1); let i = 0; while (i + 2 < c.length && q > c[i+1][0]) i++;
  const t0 = c[i], t1 = c[i+1], u = clamp((q-t0[0])/(t1[0]-t0[0]),0,1), s = u*u*(3-2*u); return [t0[1]+(t1[1]-t0[1])*s,t0[2]+(t1[2]-t0[2])*s];
}
function thighScale(y) {
  const c = [[.29,1],[.37,1.06],[.46,1.06],[.535,1]];
  const q = y / 1.83;
  if (q <= c[0][0] || q >= c.at(-1)[0]) return 1;
  let i = 0; while (i + 2 < c.length && q > c[i+1][0]) i++;
  const a = c[i], b = c[i+1], u = clamp((q-a[0])/(b[0]-a[0]),0,1), s = u*u*(3-2*u);
  return a[1]+(b[1]-a[1])*s;
}
function packFloats(values) { const b = Buffer.alloc(values.length * 4); values.forEach((x, i) => b.writeFloatLE(x, i * 4)); return b; }
function buildGlb(json, bin) {
  const jb0 = Buffer.from(JSON.stringify(json)), jl = pad4(jb0.length), bl = pad4(bin.length), out = Buffer.alloc(12+8+jl+8+bl);
  out.writeUInt32LE(0x46546c67,0); out.writeUInt32LE(2,4); out.writeUInt32LE(out.length,8); out.writeUInt32LE(jl,12); out.writeUInt32LE(0x4e4f534a,16); jb0.copy(out,20); out.fill(0x20,20+jb0.length,20+jl); out.writeUInt32LE(bl,20+jl); out.writeUInt32LE(0x004e4942,24+jl); bin.copy(out,28+jl); return out;
}

const sourceBytes = fs.readFileSync(input), sourceSha256=sha(sourceBytes);
if(sourceSha256!==EXPECTED_SOURCE_SHA256)throw new Error(`source Jericho inattendue (${sourceSha256}); le morph ne doit jamais etre applique deux fois`);
const src = parseGlb(sourceBytes), json = structuredClone(src.json);
const meshNode = json.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined), skin = json.skins[json.nodes[meshNode].skin], mesh = json.meshes[json.nodes[meshNode].mesh], prim = mesh.primitives[0];
const P = accessor(src, prim.attributes.POSITION), N = accessor(src, prim.attributes.NORMAL), UV = accessor(src, prim.attributes.TEXCOORD_0), J = accessor(src, prim.attributes.JOINTS_0), W = accessor(src, prim.attributes.WEIGHTS_0, true), IX = accessor(src, prim.indices);
const C = canonicalizer(P.values), { parents, worlds } = parentsAndWorlds(src.json.nodes), byName = new Map(src.json.nodes.map((n,i)=>[n.name,i]));
const oldJoint = new Map(skin.joints.map((n) => [n, C.to(point(worlds[n],[0,0,0]))])), rebind = new Map(oldJoint);
for (const [name, li] of byName) if (name?.startsWith('L_')) { const ri = byName.get(`R_${name.slice(2)}`); if (ri === undefined || !oldJoint.has(li) || !oldJoint.has(ri)) continue; const l=oldJoint.get(li),r=oldJoint.get(ri), x=(Math.abs(l[0])+Math.abs(r[0]))/2, y=(l[1]+r[1])/2,z=(l[2]+r[2])/2; rebind.set(li,[-x,y,z]); rebind.set(ri,[x,y,z]); }
for (const name of ['Root','Hip','Pelvis','Waist','Spine01','Spine02','NeckTwist01','NeckTwist02','Head']) { const i=byName.get(name); if(i!==undefined&&rebind.has(i)) rebind.set(i,[0,rebind.get(i)[1],rebind.get(i)[2]]); }
const finalJoint = new Map(rebind), armDelta = new Map();
const bilateralVector = (side, v) => [side === 'L' ? -v[0] : v[0], v[1], v[2]];
const upperCommon = norm(mix(
  bilateralVector('L', oldJoint.get(byName.get('L_Forearm')).map((x, i) => x - oldJoint.get(byName.get('L_Upperarm'))[i])),
  bilateralVector('R', oldJoint.get(byName.get('R_Forearm')).map((x, i) => x - oldJoint.get(byName.get('R_Upperarm'))[i])),
  .5,
));
const forearmCommon = norm(mix(
  bilateralVector('L', oldJoint.get(byName.get('L_Hand')).map((x, i) => x - oldJoint.get(byName.get('L_Forearm'))[i])),
  bilateralVector('R', oldJoint.get(byName.get('R_Hand')).map((x, i) => x - oldJoint.get(byName.get('R_Forearm'))[i])),
  .5,
));
for (const side of ['L','R']) {
  const CL=byName.get(`${side}_Clavicle`),S=byName.get(`${side}_Upperarm`),E=byName.get(`${side}_Forearm`),H=byName.get(`${side}_Hand`); if ([CL,S,E,H].some((x)=>x===undefined)) throw new Error('chaine de bras incomplete');
  const u=bilateralVector(side,upperCommon), f=bilateralVector(side,forearmCommon);
  const s=rebind.get(S), e=s.map((x,i)=>x+u[i]*.312), h=e.map((x,i)=>x+f[i]*.267); finalJoint.set(E,e); finalJoint.set(H,h);
  for (const [prefix,a,b] of [['Upperarm',S,E],['Forearm',E,H]]) for (const k of [1,2]) { const q=byName.get(`${side}_${prefix}Twist0${k}`); if(q===undefined) continue; const o=oldJoint.get(q),oa=oldJoint.get(a),ob=oldJoint.get(b), t=clamp(((o[0]-oa[0])*(ob[0]-oa[0])+(o[1]-oa[1])*(ob[1]-oa[1])+(o[2]-oa[2])*(ob[2]-oa[2]))/(dist(oa,ob)**2),0,1); finalJoint.set(q,mix(finalJoint.get(a),finalJoint.get(b),t)); }
  for (const q of [CL,S,E,H,...[1,2].flatMap(k=>[byName.get(`${side}_UpperarmTwist0${k}`),byName.get(`${side}_ForearmTwist0${k}`)])]) if(q!==undefined) armDelta.set(q,finalJoint.get(q).map((x,i)=>x-oldJoint.get(q)[i]));
}
const vCount=P.accessor.count, positions=new Float64Array(P.values.length), groups=new Map();
for(let v=0;v<vCount;v++){const p=C.to([P.values[v*3],P.values[v*3+1],P.values[v*3+2]]),key=p.map(x=>Math.round(x*1e6)).join(',');let g=groups.get(key);if(!g)groups.set(key,g={members:[],influence:new Map(),p});g.members.push(v);for(let k=0;k<4;k++){const o=v*4+k,node=skin.joints[J.values[o]],w=W.values[o];g.influence.set(node,(g.influence.get(node)??0)+w);}}
let maxMorph=0,maxTorso=0; const torsoNames=/^(Root|Hip|Pelvis|Waist|Spine|Neck|[LR]_Clavicle)/;
for(const g of groups.values()){let total=0;for(const x of g.influence.values())total+=x;let d=[0,0,0],tw=0,lw=0,lx=0,lz=0;for(const [node,w0] of g.influence){const w=w0/total,ad=armDelta.get(node);if(ad)d=d.map((x,i)=>x+ad[i]*w);const name=src.json.nodes[node].name??'';tw+=w*(torsoNames.test(name)?(name.includes('Clavicle')?.55:name.includes('Neck')?.35:1):0);if(/^[LR]_Thigh/.test(name)){const jp=finalJoint.get(node)??oldJoint.get(node);lw+=w;lx+=jp[0]*w;lz+=jp[2]*w;}}const p=g.p.map((x,i)=>x+d[i]),[sx,sz]=smoothCurve(p[1]),mask=clamp((tw-.08)/.67,0,1);let td=[p[0]*(sx-1)*mask,0,p[2]*(sz-1)*mask];if(lw>.01){const ls=thighScale(p[1]),cx=lx/lw,cz=lz/lw;td[0]+=(p[0]-cx)*(ls-1)*lw;td[2]+=(p[2]-cz)*(ls-1)*lw;}let tl=Math.hypot(...td);if(tl>.03)td=td.map(x=>x*.03/tl);maxMorph=Math.max(maxMorph,Math.hypot(...d));maxTorso=Math.max(maxTorso,Math.hypot(...td));for(const v of g.members){const q=C.to([P.values[v*3],P.values[v*3+1],P.values[v*3+2]]).map((x,i)=>x+d[i]+td[i]),s=C.from(q);positions.set(s,v*3);}}
let invertedTriangles=0,minAreaRatio=Infinity,maxAreaRatio=0;for(let t=0;t<IX.values.length;t+=3){const ids=[IX.values[t],IX.values[t+1],IX.values[t+2]],cross=(values)=>{const p=ids.map(i=>C.to([values[i*3],values[i*3+1],values[i*3+2]])),a=p[1].map((x,k)=>x-p[0][k]),b=p[2].map((x,k)=>x-p[0][k]);return[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];},before=cross(P.values),after=cross(positions),a0=Math.hypot(...before),a1=Math.hypot(...after);if(a0<1e-12)continue;const ratio=a1/a0;minAreaRatio=Math.min(minAreaRatio,ratio);maxAreaRatio=Math.max(maxAreaRatio,ratio);if(before[0]*after[0]+before[1]*after[1]+before[2]*after[2]<=0)invertedTriangles++;}
if(invertedTriangles!==0||minAreaRatio<.6||maxAreaRatio>1.5)throw new Error(`deformation invalide: ${invertedTriangles} triangles inverses, aire ${minAreaRatio}..${maxAreaRatio}`);
const targetSource=new Map([...finalJoint].map(([i,p])=>[i,C.from(p)])), outNodes=json.nodes, newWorld=Array(outNodes.length);
const worldAt=(i)=>newWorld[i]??=(()=>{const pw=parents[i]<0?I():worldAt(parents[i]);if(targetSource.has(i)){if(outNodes[i].matrix)throw new Error(`joint ${i} en matrix`);outNodes[i].translation=point(inv(pw),targetSource.get(i));}return mul(pw,nodeMatrix(outNodes[i]));})(); outNodes.forEach((_,i)=>worldAt(i));
const meshWorld=newWorld[meshNode],ibm=[];let paletteError=0;for(const j of skin.joints){const b=mul(inv(newWorld[j]),meshWorld);ibm.push(...b);const test=mul(mul(inv(meshWorld),newWorld[j]),b);for(let k=0;k<16;k++)paletteError=Math.max(paletteError,Math.abs(test[k]-(k%5===0?1:0)));}
const append=[];let cursor=pad4(src.bin.length);const add=(data,target)=>{const b=packFloats(data),view=json.bufferViews.length;json.bufferViews.push({buffer:0,byteOffset:cursor,byteLength:b.length,...(target?{target}:{})});append.push({offset:cursor,b});cursor=pad4(cursor+b.length);return view;};
const bounds=[0,1,2].map(a=>{let mn=Infinity,mx=-Infinity;for(let i=a;i<positions.length;i+=3){mn=Math.min(mn,positions[i]);mx=Math.max(mx,positions[i]);}return[mn,mx];});
const pa=json.accessors.length;json.accessors.push({bufferView:add(positions,34962),componentType:5126,count:vCount,type:'VEC3',min:bounds.map(x=>x[0]),max:bounds.map(x=>x[1])});const ia=json.accessors.length;json.accessors.push({bufferView:add(ibm),componentType:5126,count:skin.joints.length,type:'MAT4'});prim.attributes.POSITION=pa;skin.inverseBindMatrices=ia;json.buffers[0].byteLength=cursor;
const bin=Buffer.alloc(cursor);src.bin.copy(bin);for(const x of append)x.b.copy(bin,x.offset);const result=buildGlb(json,bin);
const preserved={normals:sha(N.bytes),uv:sha(UV.bytes),indices:sha(IX.bytes),joints:sha(J.bytes),weights:sha(W.bytes),images:(src.json.images??[]).map(im=>{const bv=src.json.bufferViews[im.bufferView];return sha(src.bin.subarray(bv.byteOffset??0,(bv.byteOffset??0)+bv.byteLength));}),binPrefix:sha(src.bin)};
const arm=(map,s)=>{const shoulder=map.get(byName.get(`${s}_Upperarm`)),elbow=map.get(byName.get(`${s}_Forearm`)),hand=map.get(byName.get(`${s}_Hand`));return{shoulder,elbow,hand,upper:dist(shoulder,elbow),forearm:dist(elbow,hand),upperDirection:norm(elbow.map((x,i)=>x-shoulder[i])),forearmDirection:norm(hand.map((x,i)=>x-elbow[i]))};};
const report={ok:true,mode:analyze?'analyze':'write',input,output:analyze?null:output,source:{sha256:sourceSha256,bytes:sourceBytes.length,vertices:vCount,triangles:IX.values.length/3},profile:{heightM:1.83,upperArmM:.312,forearmM:.267},arms:{before:{L:arm(oldJoint,'L'),R:arm(oldJoint,'R')},after:{L:arm(finalJoint,'L'),R:arm(finalJoint,'R')}},deformation:{maxRelativeArmM:maxMorph,maxTorsoM:maxTorso,weldGroups:groups.size},meshQuality:{invertedTriangles,minAreaRatio,maxAreaRatio},rig:{joints:skin.joints.length,maxRestPaletteError:paletteError},preserved,outputAsset:{sha256:sha(result),bytes:result.length}};
if(!analyze){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,result);fs.writeFileSync(reportPath,`${JSON.stringify(report,null,2)}\n`);}process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
