"""Build a rigged host sea anemone in Blender (run inside Blender).

Matches the reefscape host (scenes/reefscape/src/anemone*.js): a short column stub (the
upper 2/5 of the host's column; the rest is meant to be hidden in a rock crevice), a
flared rim, a domed oral disc with a slit mouth, and a phyllotactic
crown of long fingered tentacles. Units are reefscape tank units: 1 BU = 10 cm.

Rig (Anemone_Rig):
  root                 base of the stub, the anchor in the rock (keep it still)
  column.01-03         the stalk, for sway
  disc                 oral disc; every tentacle chain hangs off it, so scaling it
                       contracts the whole crown
  tentacle.NNN.01-04   one 4-bone chain per tentacle. Local X is the bend axis:
                       +X rotation curls the tentacle outward/down, -X inward/up,
                       Z rotation swings it sideways. Base bones carry ring/angle/phase.
Run it from Blender's Text Editor (or exec() it over the Blender MCP). Rerunning
replaces only the objects in the "Anemone" collection.
"""
import bpy, bmesh, math, random
from mathutils import Vector, Color

TAU = math.tau
GOLDEN = math.pi * (3 - math.sqrt(5))
S = 1.25 / 0.90                     # host crown scale (radius 1.25 / REACH)
H = 0.66 * S                        # full column height the profile is drawn over
CUT = 0.60                          # share of the column cut away below the stub
STUB = (1 - CUT) * H                # column height kept: it stands in a rock crevice
RIM = 0.36 * S                      # rim radius
DISC_R = RIM - 0.06                 # oral-disc radius, inside the rolled lip
DISC_Z = STUB + 0.08                   # oral disc height at its edge
SEG = 96                            # body segments around
N_TENT = 96
TENT_SIDES, TENT_STEPS, TENT_BONES = 10, 24, 4


def smoothstep(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def srgb(hexstr):
    c = Color([int(hexstr[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    return Vector(c.from_srgb_to_scene_linear())


def mix(a, b, t):
    return a.lerp(b, min(max(t, 0.0), 1.0))


FOOT, SHAFT, LIP, WART = srgb('#4a2420'), srgb('#84402e'), srgb('#a8663e'), srgb('#c89a80')
DISC, LIPS, MOUTH = srgb('#a8564c'), srgb('#c07868'), srgb('#3a1018')
T_ROOT, T_SHAFT_A, T_SHAFT_B = srgb('#4e3216'), srgb('#c4a23e'), srgb('#d8bc4c')
T_BAND, T_TIP = srgb('#8c7026'), srgb('#f0ebe2')

COLUMN = [(0, .37), (.10, .31), (.5, .28), (1, .36)]


def column_radius(u):
    for (u0, r0), (u1, r1) in zip(COLUMN, COLUMN[1:]):
        if u <= u1:
            return S * lerp(r0, r1, .5 - .5 * math.cos(math.pi * (u - u0) / (u1 - u0)))
    return RIM


def disc_height(r):
    v = 1 - r / DISC_R
    return DISC_Z + .045 * S * smoothstep(0, .45, v)


# --------------------------------------------------------------------------- cleanup
coll = bpy.data.collections.get('Anemone')
if coll:
    for ob in list(coll.objects):
        data = ob.data
        bpy.data.objects.remove(ob, do_unlink=True)
        if data and data.users == 0:
            (bpy.data.meshes if isinstance(data, bpy.types.Mesh) else bpy.data.armatures).remove(data)
else:
    coll = bpy.data.collections.new('Anemone')
    bpy.context.scene.collection.children.link(coll)
for name in ('Anemone_Body', 'Anemone_Tentacles'):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)

rng = random.Random(8945)

# --------------------------------------------------------------------------- body profile
# (r, z, region, u) rings from the pedal disc centre, up the column, over the lip,
# across the oral disc and down into the mouth.
prof = []
for k in range(1, 7):
    prof.append((column_radius(CUT) * k / 6, 0.004 * k / 6, 'foot', CUT))
prof.append((column_radius(CUT) + 0.008, 0.012, 'foot', CUT))
for k in range(1, 21):
    u = CUT + (1 - CUT) * k / 20
    prof.append((column_radius(u), (u - CUT) * H, 'column', u))
for dr, dz in ((.012, .022), (.014, .045), (.002, .064), (-.022, .076), (-.045, .080)):
    prof.append((RIM + dr, STUB + dz, 'lip', 1.0))
for k in range(0, 22):
    r = lerp(DISC_R - .005, .10, k / 21)
    prof.append((r, disc_height(r), 'disc', 1.0))
top = disc_height(0)
for r, dz, reg in ((.085, .012, 'lips'), (.072, .030, 'lips'), (.058, .034, 'lips'),
                   (.046, .018, 'lips'), (.038, -.010, 'mouth'), (.030, -.045, 'mouth'),
                   (.018, -.075, 'mouth')):
    prof.append((r, top + dz, reg, 1.0))
mouth_bottom = top - .085

# Verrucae: a staggered lattice crowding toward the rim, some sites left bare.
warts = []
for row in range(12):
    for col in range(20):
        if rng.random() < .22:
            continue
        cu = ((row + .5 + (rng.random() - .5) * .9) / 12) ** .55
        ca = (col + .5 + (row % 2) / 2 + (rng.random() - .5) * .9) / 20 * TAU
        size = .020 * S * (.45 + .9 * rng.random()) * (.5 + .5 * cu)
        warts.append((ca, cu, size, .55 + .45 * rng.random()))


def wart_at(a, u):
    best = 0.0
    for ca, cu, size, amp in warts:
        du = (u - cu) * H
        if abs(du) > 3 * size:
            continue
        da = math.atan2(math.sin(a - ca), math.cos(a - ca)) * column_radius(u)
        best = max(best, math.exp(-(da * da + du * du) / (size * size) * 1.6) * amp)
    return best


verts, cols, groups = [], [], []   # groups: list of {bone: weight}
col_anchor = [('root', 0.0), ('column.01', STUB / 6), ('column.02', STUB / 2),
              ('column.03', 5 * STUB / 6), ('disc', STUB)]


def column_weights(z):
    if z <= 0.0:
        return {'root': 1.0}
    for (b0, z0), (b1, z1) in zip(col_anchor, col_anchor[1:]):
        if z <= z1:
            t = (z - z0) / (z1 - z0)
            return {b0: 1 - t, b1: t}
    return {'disc': 1.0}


verts.append(Vector((0, 0, 0)))
cols.append(FOOT)
groups.append({'root': 1.0})
for r, z, reg, u in prof:
    for i in range(SEG):
        a = i / SEG * TAU
        rr, c = r, None
        if reg == 'column':
            fold = .006 * math.sin(14 * a + 2.3 * u) + .004 * math.sin(31 * a - 5 * u)
            w = wart_at(a, u)
            rr = r * (1 + fold * smoothstep(.05, .3, u)) + w * .014 * S
            c = mix(FOOT, SHAFT, smoothstep(CUT, CUT + .15, u))
            c = mix(c, LIP, smoothstep(.82, 1, u))
            c = mix(c, WART, w * .75)
            c = c * (.94 + .06 * math.sin(14 * a + 2.3 * u))
        elif reg == 'foot':
            c = FOOT
        elif reg == 'lip':
            c = mix(LIP, DISC, .35)
        elif reg == 'disc':
            c = mix(DISC, LIPS, .18 * (.5 + .5 * math.sin(24 * a)) * smoothstep(DISC_R, .12, r))
        elif reg == 'lips':
            c = LIPS
        else:
            c = mix(LIPS, MOUTH, smoothstep(.038, .02, r))
        x, y = rr * math.cos(a), rr * math.sin(a)
        m = smoothstep(.12, .05, r)          # squeeze the mouth into a slit along X
        x *= 1 + .55 * m
        y *= 1 - .45 * m
        verts.append(Vector((x, y, z)))
        cols.append(c)
        if reg == 'foot':
            groups.append({'root': 1.0})
        elif reg == 'column':
            groups.append(column_weights(z))
        else:
            groups.append({'disc': 1.0})
verts.append(Vector((0, 0, mouth_bottom)))
cols.append(MOUTH)
groups.append({'disc': 1.0})

faces, uvs = [], []
nring = len(prof)
ring0 = lambda k: 1 + k * SEG
for i in range(SEG):                       # pedal disc fan
    j = (i + 1) % SEG
    faces.append((0, ring0(0) + j, ring0(0) + i))
    uvs.append([(.5, 0), ((i + 1) / SEG, 0), (i / SEG, 0)])
for k in range(nring - 1):
    v0, v1 = k / (nring - 1), (k + 1) / (nring - 1)
    for i in range(SEG):
        j = (i + 1) % SEG
        faces.append((ring0(k) + i, ring0(k) + j, ring0(k + 1) + j, ring0(k + 1) + i))
        uvs.append([(i / SEG, v0), ((i + 1) / SEG, v0), ((i + 1) / SEG, v1), (i / SEG, v1)])
last = len(verts) - 1
for i in range(SEG):                       # mouth fan
    j = (i + 1) % SEG
    faces.append((ring0(nring - 1) + i, ring0(nring - 1) + j, last))
    uvs.append([(i / SEG, 1), ((i + 1) / SEG, 1), (.5, 1)])


def build_mesh(name, verts, faces, uvs, cols, mat):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    uv = me.uv_layers.new(name='UVMap')
    flat = [c for f in uvs for p in f for c in p]
    uv.data.foreach_set('uv', flat)
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    ca.data.foreach_set('color', [x for c in cols for x in (c[0], c[1], c[2], 1.0)])
    me.color_attributes.active_color = ca
    me.color_attributes.render_color_index = 0
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    return ob


def make_material(name, rough, sss, coat):
    mat = bpy.data.materials.new(name)
    nt = mat.node_tree
    bsdf = nt.nodes.get('Principled BSDF')
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Col'
    attr.location = (-300, 200)
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Subsurface Weight'].default_value = sss
    bsdf.inputs['Subsurface Radius'].default_value = (1.0, .35, .2)
    bsdf.inputs['Subsurface Scale'].default_value = .05
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = .15
    return mat


body = build_mesh('Anemone_Body', verts, faces, uvs, cols, make_material('Anemone_Body', .55, .25, .12))
body_groups = groups

# --------------------------------------------------------------------------- tentacles
R0 = .24
tentacles = []
for i in range(N_TENT):
    rr = math.sqrt(R0 * R0 + (1 - R0 * R0) * (i + .5) / N_TENT)
    ring = (rr - R0) / (1 - R0)
    angle = i * GOLDEN + (rng.random() - .5) * .44
    radius = min(max(rr + (rng.random() - .5) * .10, R0 * .9), 1)
    length = .41 * S ** 1.15 * (.88 + .50 * ring) * (.86 + .28 * rng.random())
    girth = .041 * S ** .70 * (.85 + .30 * rng.random())
    tilt = (.25 + .75 * ring ** 1.2) * 1.25
    curl = (.20 + .80 * rng.random()) * (.60 + .75 * ring) * .9
    wander = (rng.random() - .5) * .9
    wave = (.4 + .6 * rng.random()) * (1 if rng.random() < .5 else -1)
    phase = rng.random()
    tone = rng.random()
    tentacles.append(dict(ring=ring, angle=angle, radius=radius, length=length, girth=girth,
                          tilt=tilt, curl=curl, wander=wander, wave=wave, phase=phase, tone=tone))

tv, tf, tuv, tc, tg = [], [], [], [], []
chains = []   # per tentacle: list of (head, tail, x_axis)
up = Vector((0, 0, 1))
for n, t in enumerate(tentacles):
    a = t['angle']
    u_dir = Vector((math.cos(a), math.sin(a), 0))
    w_dir = Vector((-math.sin(a), math.cos(a), 0))
    rr = t['radius'] * DISC_R
    root = Vector((rr * math.cos(a), rr * math.sin(a), disc_height(rr) - .012))
    L = t['length']

    def direction(s):
        phi = t['tilt'] + t['curl'] * s ** 1.6 + .35 * t['wave'] * math.sin(TAU * 1.1 * s + t['phase'] * TAU) * s
        psi = t['wander'] * math.sin(math.pi * s + t['phase'] * TAU) * s
        return (up * math.cos(phi) + (u_dir * math.cos(psi) + w_dir * math.sin(psi)) * math.sin(phi)).normalized()

    pts = [root.copy()]
    for k in range(TENT_STEPS):
        pts.append(pts[-1] + direction((k + .5) / TENT_STEPS) * (L / TENT_STEPS))

    def radius_at(s):
        return t['girth'] * (1 - .25 * s) * (1 + .30 * (1 - smoothstep(0, .08, s)))

    def color_at(s):
        c = mix(T_SHAFT_A, T_SHAFT_B, t['tone'])
        c = mix(T_ROOT, c, smoothstep(0, .18, s))
        band = smoothstep(.55, .95, .5 + .5 * math.sin(s * 22 + t['phase'] * 9))
        c = mix(c, T_BAND, band * .35 * smoothstep(.1, .3, s) * (1 - smoothstep(.75, .85, s)))
        return mix(c, T_TIP, smoothstep(.78, .96, s))

    def weights_at(s):
        x = min(max(s * TENT_BONES - .5, 0), TENT_BONES - 1)
        i0 = min(int(x), TENT_BONES - 2)
        f = x - i0
        b = lambda k: f'tentacle.{n:03d}.{k + 1:02d}'
        return {b(i0): 1 - f, b(i0 + 1): f}

    def frame(k):
        T = (pts[min(k + 1, TENT_STEPS)] - pts[max(k - 1, 0)]).normalized()
        N = (w_dir - T * w_dir.dot(T)).normalized()
        return T, N, T.cross(N)

    base = len(tv)
    # root cap centre, rings along the shaft, rounded tip cap
    tv.append(root - direction(0) * .01)
    tc.append(T_ROOT)
    tg.append(weights_at(0))
    rings = []
    for k in range(TENT_STEPS + 1):
        s = k / TENT_STEPS
        T, N, B = frame(k)
        rings.append((pts[k], T, N, B, radius_at(s), s))
    endT = rings[-1][1]
    tip_r = rings[-1][4]
    for q in range(1, 4):
        th = q / 4 * math.pi / 2
        p, T, N, B, _, _ = rings[-1]
        rings.append((p + endT * math.sin(th) * tip_r * 1.3, T, N, B, tip_r * math.cos(th), 1.0))
    for p, T, N, B, r, s in rings:
        for j in range(TENT_SIDES):
            th = j / TENT_SIDES * TAU
            tv.append(p + (N * math.cos(th) + B * math.sin(th)) * r)
            tc.append(color_at(s))
            tg.append(weights_at(s))
    tip = len(tv)
    tv.append(pts[-1] + endT * tip_r * 1.3)
    tc.append(T_TIP)
    tg.append(weights_at(1))

    ringv = lambda k: base + 1 + k * TENT_SIDES
    nr = len(rings)
    vs = [min(rg[5], 1.0) for rg in rings]
    for j in range(TENT_SIDES):
        jj = (j + 1) % TENT_SIDES
        tf.append((base, ringv(0) + jj, ringv(0) + j))
        tuv.append([(.5, 0), ((j + 1) / TENT_SIDES, 0), (j / TENT_SIDES, 0)])
        for k in range(nr - 1):
            tf.append((ringv(k) + j, ringv(k) + jj, ringv(k + 1) + jj, ringv(k + 1) + j))
            tuv.append([(j / TENT_SIDES, vs[k]), ((j + 1) / TENT_SIDES, vs[k]),
                        ((j + 1) / TENT_SIDES, vs[k + 1]), (j / TENT_SIDES, vs[k + 1])])
        tf.append((ringv(nr - 1) + j, ringv(nr - 1) + jj, tip))
        tuv.append([(j / TENT_SIDES, 1), ((j + 1) / TENT_SIDES, 1), (.5, 1)])

    step = TENT_STEPS // TENT_BONES
    chains.append([(pts[k * step], pts[(k + 1) * step], w_dir) for k in range(TENT_BONES)])

tent = build_mesh('Anemone_Tentacles', tv, tf, tuv, tc,
                  make_material('Anemone_Tentacles', .45, .45, .3))

# --------------------------------------------------------------------------- armature
arm_data = bpy.data.armatures.new('Anemone_Rig')
arm = bpy.data.objects.new('Anemone_Rig', arm_data)
coll.objects.link(arm)
arm_data.display_type = 'OCTAHEDRAL'
arm.show_in_front = True
arm['units'] = '1 BU = 10 cm (reefscape tank units)'
bcol = {name: arm_data.collections.new(name) for name in
        ('Root', 'Column', 'Disc', 'Tentacles Inner', 'Tentacles Middle', 'Tentacles Outer')}

for ob in bpy.context.view_layer.objects:
    ob.select_set(False)
bpy.context.view_layer.objects.active = arm
arm.select_set(True)
bpy.ops.object.mode_set(mode='EDIT')
eb = arm_data.edit_bones


def bone(name, head, tail, parent=None, connect=False, collection=None):
    b = eb.new(name)
    b.head, b.tail = head, tail
    b.parent = parent
    b.use_connect = connect
    bcol[collection].assign(b)
    return b


root_b = bone('root', (0, 0, 0), (0, 0, .15), collection='Root')
prev = root_b
for k in range(3):
    prev = bone(f'column.{k + 1:02d}', (0, 0, STUB * k / 3), (0, 0, STUB * (k + 1) / 3),
                parent=prev, connect=k > 0, collection='Column')
disc_b = bone('disc', (0, 0, STUB), (0, 0, top + .12), parent=prev, connect=True, collection='Disc')
for n, chain in enumerate(chains):
    ring = tentacles[n]['ring']
    group = 'Tentacles Inner' if ring < .34 else 'Tentacles Middle' if ring < .67 else 'Tentacles Outer'
    parent = disc_b
    for k, (h, tl, x_axis) in enumerate(chain):
        b = bone(f'tentacle.{n:03d}.{k + 1:02d}', h, tl, parent=parent, connect=k > 0, collection=group)
        y = (tl - h).normalized()
        b.align_roll(x_axis.cross(y))      # local X = bend axis (tangent to the crown)
        parent = b
bpy.ops.object.mode_set(mode='OBJECT')

for n, t in enumerate(tentacles):
    pb = arm.pose.bones[f'tentacle.{n:03d}.01']
    pb['ring'] = round(t['ring'], 4)
    pb['angle'] = round(t['angle'] % TAU, 4)
    pb['phase'] = round(t['phase'], 4)

# --------------------------------------------------------------------------- skinning
for ob, gs in ((body, body_groups), (tent, tg)):
    vgs = {}
    for vi, g in enumerate(gs):
        for name, w in g.items():
            if w <= 1e-4:
                continue
            vg = vgs.get(name) or ob.vertex_groups.new(name=name)
            vgs[name] = vg
            vg.add([vi], w, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm

arm.select_set(False)
result = {'body_verts': len(body.data.vertices), 'tentacle_verts': len(tent.data.vertices),
          'bones': len(arm_data.bones), 'height': round(top, 3),
          'reach': round(max(math.hypot(v.x, v.y) for v in tv), 3)}
