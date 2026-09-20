/* LaserAct multi-sensor point-cloud viewer.
 * Five synchronized three.js panels (velodyne, livox, cepton, blickfeld,
 * depth) playing one sequence on the common clock. Cameras are linked:
 * orbiting any panel moves all of them.
 */
(function () {
  'use strict';

  var SENSORS = ['velodyne', 'livox', 'cepton', 'blickfeld', 'depth'];
  var LABELS = {velodyne: 'Velodyne HDL-32E', livox: 'Livox MID-100',
                cepton: 'Cepton Vista-P60', blickfeld: 'Blickfeld Cube 1',
                depth: 'RGB-D (depth)'};
  var BASE = 'assets/viewer/';

  var panels = {};       // sensor -> {renderer, scene, camera, points, data}
  var current = null;    // loaded sequence meta
  var playing = true;
  var speed = 1.0;
  var tNow = 0;
  var lastWall = null;
  var masterControls = null;
  var showPerson = false;   // person-crop clouds instead of raw
  var showPose = true;      // lifted 3D skeleton overlay
  var pose = null;          // {stamps, actors, data(Int16Array), frame}
  // COCO-17 skeleton edges, actor colors as in the preview videos
  var EDGES = [[0, 1], [0, 2], [1, 3], [2, 4], [5, 6], [5, 7], [7, 9],
               [6, 8], [8, 10], [5, 11], [6, 12], [11, 12], [11, 13],
               [13, 15], [12, 14], [14, 16]];
  var ACTOR_COLORS = [0x50dc50, 0xdc50dc];

  // ---- turbo colormap (Mikhailov polynomial approximation) ------------
  function turbo(t) {
    t = Math.min(Math.max(t, 0), 1);
    var t2 = t * t, t3 = t2 * t, t4 = t3 * t, t5 = t4 * t;
    return [
      Math.min(Math.max(0.13572138 + 4.61539260 * t - 42.66032258 * t2
        + 132.13108234 * t3 - 152.94239396 * t4 + 59.28637943 * t5, 0), 1),
      Math.min(Math.max(0.09140261 + 2.19418839 * t + 4.84296658 * t2
        - 14.18503333 * t3 + 4.27729857 * t4 + 2.82956604 * t5, 0), 1),
      Math.min(Math.max(0.10667330 + 12.64194608 * t - 60.58204836 * t2
        + 110.36276771 * t3 - 89.90310912 * t4 + 27.34824973 * t5, 0), 1),
    ];
  }

  function makePanel(sensor, container) {
    var el = document.createElement('div');
    el.className = 'v-panel';
    var label = document.createElement('div');
    label.className = 'v-label';
    label.textContent = LABELS[sensor];
    el.appendChild(label);
    container.appendChild(el);

    var renderer = new THREE.WebGLRenderer({antialias: false});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);

    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1016);
    var camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.05, 60);
    camera.position.set(2.6, 1.6, 2.2);
    camera.lookAt(0, 0.2, -3.2);

    var grid = new THREE.GridHelper(10, 20, 0x22303c, 0x1a242e);
    grid.position.set(0, -1.4, -3.5);
    scene.add(grid);

    var controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.2, -3.2);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.update();

    panels[sensor] = {el: el, renderer: renderer, scene: scene,
                      camera: camera, controls: controls,
                      clouds: {raw: null, person: null}, frame: -1,
                      bones: [], joints: []};
    if (!masterControls) masterControls = panels[sensor];
  }

  function resize() {
    for (var s in panels) {
      var p = panels[s];
      var w = p.el.clientWidth;
      var h = Math.round(w * 0.75);
      p.renderer.setSize(w, h, false);
      p.camera.aspect = w / h;
      p.camera.updateProjectionMatrix();
    }
  }

  // canonical (x fwd, y left, z up) -> three.js (x right, y up, z toward cam)
  function toThree(x, y, z) { return [-y, z, -x]; }

  function loadSequence(seqId) {
    var status = document.getElementById('v-status');
    status.textContent = 'loading …';
    fetch(BASE + seqId + '/meta.json?v=4').then(function (r) { return r.json(); })
      .then(function (meta) {
        var jobs = [];
        SENSORS.forEach(function (s) {
          if (meta.sensors[s]) {
            jobs.push(fetch(BASE + seqId + '/' + meta.sensors[s].file + '?v=4')
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                return ['raw', s, new Int16Array(buf)];
              }));
          }
          if (meta.person && meta.person[s]) {
            jobs.push(fetch(BASE + seqId + '/' + meta.person[s].file + '?v=4')
              .then(function (r) { return r.arrayBuffer(); })
              .then(function (buf) {
                return ['person', s, new Int16Array(buf)];
              }));
          }
        });
        if (meta.poses) {
          jobs.push(fetch(BASE + seqId + '/' + meta.poses.file + '?v=4')
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (buf) {
              return ['poses', null, new Int16Array(buf)];
            }));
        }
        return Promise.all(jobs).then(function (results) {
          current = meta;
          pose = null;
          results.forEach(function (trip) {
            if (trip[0] === 'poses') {
              pose = {stamps: meta.poses.stamps, actors: meta.poses.actors,
                      data: trip[2], frame: -1};
            } else {
              installSensor(trip[1], meta, trip[2], trip[0]);
            }
          });
          buildSkeletons();
          applyCloudMode();
          tNow = 0;
          lastWall = null;
          var scrub = document.getElementById('v-scrub');
          scrub.max = meta.duration;
          status.textContent = meta.label + ' · ' +
            meta.duration.toFixed(1) + ' s';
        });
      })
      .catch(function (e) { status.textContent = 'load failed: ' + e; });
  }

  // one skeleton set per panel (identical geometry, one scene each)
  function buildSkeletons() {
    for (var s in panels) {
      var p = panels[s];
      p.bones.forEach(function (b) {
        p.scene.remove(b); b.geometry.dispose(); b.material.dispose();
      });
      p.joints.forEach(function (j) {
        p.scene.remove(j); j.geometry.dispose(); j.material.dispose();
      });
      p.bones = []; p.joints = [];
      if (!pose) continue;
      for (var a = 0; a < pose.actors; a++) {
        var bg = new THREE.BufferGeometry();
        bg.setAttribute('position', new THREE.BufferAttribute(
          new Float32Array(EDGES.length * 2 * 3), 3));
        var bones = new THREE.LineSegments(bg, new THREE.LineBasicMaterial(
          {color: ACTOR_COLORS[a % ACTOR_COLORS.length]}));
        bones.frustumCulled = false;
        p.scene.add(bones);
        p.bones.push(bones);
        var jg = new THREE.BufferGeometry();
        jg.setAttribute('position', new THREE.BufferAttribute(
          new Float32Array(17 * 3), 3));
        var joints = new THREE.Points(jg, new THREE.PointsMaterial(
          {color: ACTOR_COLORS[a % ACTOR_COLORS.length], size: 0.07}));
        joints.frustumCulled = false;
        p.scene.add(joints);
        p.joints.push(joints);
      }
    }
    if (pose) pose.frame = -1;
  }

  function jointAt(f, a, j, inv) {
    if (f < 0) return null;
    var off = ((f * pose.actors + a) * 17 + j) * 4;
    if (pose.data[off + 3] <= 0) return null;
    return [pose.data[off] * inv, pose.data[off + 1] * inv,
            pose.data[off + 2] * inv];
  }

  function updateSkeletons(t) {
    var inv = 1.0 / current.scale;
    // surrounding pose frames + blend factor
    var f0 = frameAt(pose.stamps, t);
    var f1 = (f0 + 1 < pose.stamps.length) ? f0 + 1 : f0;
    var alpha = 0;
    if (f1 > f0 && f0 >= 0) {
      var span = pose.stamps[f1] - pose.stamps[f0];
      if (span > 0 && span < 0.5) {
        alpha = Math.min(Math.max((t - pose.stamps[f0]) / span, 0), 1);
      }
    }
    for (var a = 0; a < pose.actors; a++) {
      var pts = [];       // three.js coords per joint, null if invalid
      for (var j = 0; j < 17; j++) {
        var u0 = jointAt(f0, a, j, inv);
        var u1 = (alpha > 0) ? jointAt(f1, a, j, inv) : null;
        var w;
        if (u0 && u1) {
          w = [u0[0] + alpha * (u1[0] - u0[0]),
               u0[1] + alpha * (u1[1] - u0[1]),
               u0[2] + alpha * (u1[2] - u0[2])];
        } else {
          w = u0 || u1;
        }
        pts.push(w ? toThree(w[0], w[1], w[2]) : null);
      }
      for (var s in panels) {
        var p = panels[s];
        var bpos = p.bones[a].geometry.attributes.position;
        var k = 0;
        for (var e = 0; e < EDGES.length; e++) {
          var u = pts[EDGES[e][0]], v = pts[EDGES[e][1]];
          if (u && v && showPose) {
            bpos.array.set(u, k); bpos.array.set(v, k + 3);
            k += 6;
          }
        }
        p.bones[a].geometry.setDrawRange(0, k / 3);
        bpos.needsUpdate = true;
        var jpos = p.joints[a].geometry.attributes.position;
        var m = 0;
        if (showPose) {
          for (var q = 0; q < 17; q++) {
            if (pts[q]) { jpos.array.set(pts[q], m); m += 3; }
          }
        }
        p.joints[a].geometry.setDrawRange(0, m / 3);
        jpos.needsUpdate = true;
      }
    }
  }

  function applyCloudMode() {
    for (var s in panels) {
      var p = panels[s];
      var hasPerson = !!p.clouds.person;
      if (p.clouds.raw) {
        p.clouds.raw.points.visible = !(showPerson && hasPerson);
      }
      if (p.clouds.person) p.clouds.person.points.visible = showPerson;
      p.frame = -1;   // force a draw-range refresh
    }
  }

  function installSensor(sensor, meta, raw, kind) {
    var p = panels[sensor];
    var sm = (kind === 'person' ? meta.person : meta.sensors)[sensor];
    var inv = 1.0 / meta.scale;
    var n = raw.length / 3;
    var pos = new Float32Array(n * 3);
    var col = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      var x = raw[3 * i] * inv, y = raw[3 * i + 1] * inv,
          z = raw[3 * i + 2] * inv;
      var t3 = toThree(x, y, z);
      pos[3 * i] = t3[0]; pos[3 * i + 1] = t3[1]; pos[3 * i + 2] = t3[2];
      var c = turbo((x - 0.3) / 8.7);
      col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2];
    }
    // frame index -> [start, count] in points
    var offsets = [];
    var acc = 0;
    for (var f = 0; f < sm.counts.length; f++) {
      offsets.push(acc);
      acc += sm.counts[f];
    }
    var old = p.clouds[kind];
    if (old) {
      p.scene.remove(old.points);
      old.points.geometry.dispose();
      old.points.material.dispose();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    var mat = new THREE.PointsMaterial({size: 0.035, vertexColors: true});
    var points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    p.scene.add(points);
    p.clouds[kind] = {points: points, offsets: offsets,
                      counts: sm.counts, stamps: sm.stamps};
    p.frame = -1;
  }

  function frameAt(stamps, t) {
    var lo = -1;
    for (var i = 0; i < stamps.length; i++) {
      if (stamps[i] <= t) lo = i; else break;
    }
    return lo;
  }

  function tick(wall) {
    requestAnimationFrame(tick);
    if (lastWall === null) lastWall = wall;
    var dt = (wall - lastWall) / 1000;
    lastWall = wall;
    if (current && playing) {
      tNow += dt * speed;
      if (tNow > current.duration) tNow = 0;
      document.getElementById('v-scrub').value = tNow;
    }
    masterControls.controls.update();
    if (pose && current) {
      updateSkeletons(tNow);
    }
    for (var s in panels) {
      var p = panels[s];
      if (p !== masterControls) {
        p.camera.position.copy(masterControls.camera.position);
        p.camera.quaternion.copy(masterControls.camera.quaternion);
        p.controls.target.copy(masterControls.controls.target);
      }
      var active = (showPerson && p.clouds.person) ? p.clouds.person
                                                     : p.clouds.raw;
      if (active) {
        var f = frameAt(active.stamps, tNow);
        if (f !== p.frame) {
          p.frame = f;
          if (f < 0) {
            active.points.geometry.setDrawRange(0, 0);
          } else {
            active.points.geometry.setDrawRange(active.offsets[f],
                                                active.counts[f]);
          }
        }
      }
      p.renderer.render(p.scene, p.camera);
    }
  }

  function fail(msg) {
    var s = document.getElementById('v-status');
    if (s) s.textContent = msg;
    var g = document.getElementById('v-grid');
    if (g) {
      g.innerHTML = '';
      var p = document.createElement('p');
      p.className = 'v-error';
      p.textContent = msg;
      g.appendChild(p);
    }
  }

  window.initViewer = function () {
    var grid = document.getElementById('v-grid');
    // A WebGL failure used to throw out of the first makePanel(), leaving
    // the page stuck on "loading …" with four missing panels and no clue
    // why. Report it instead.
    try {
      SENSORS.forEach(function (s) { makePanel(s, grid); });
    } catch (e) {
      fail('This browser could not start WebGL, so the 3D viewer cannot '
           + 'run. Try a different browser, or enable hardware acceleration.');
      return;
    }
    resize();
    window.addEventListener('resize', resize);

    fetch(BASE + 'manifest.json?v=4')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (m) {
        var sel = document.getElementById('v-action');
        m.sequences.forEach(function (e) {
          var o = document.createElement('option');
          o.value = e.seq_id;
          o.textContent = e.label;
          sel.appendChild(o);
        });
        sel.onchange = function () { loadSequence(sel.value); };
        loadSequence(m.sequences[0].seq_id);
      })
      .catch(function () {
        // by far the most common cause: index.html opened straight from
        // disk, where fetch() of the sequence data is blocked by CORS
        fail(location.protocol === 'file:'
          ? 'The viewer needs the page to be served over http. Run '
            + '"python3 -m http.server" in this folder and open '
            + 'http://localhost:8000 instead of the file directly.'
          : 'Could not load the sequence data (assets/viewer/manifest.json).');
      });

    document.getElementById('v-play').onclick = function () {
      playing = !playing;
      this.textContent = playing ? 'pause' : 'play';
    };
    document.getElementById('v-speed').onchange = function () {
      speed = parseFloat(this.value);
    };
    var scrub = document.getElementById('v-scrub');
    scrub.oninput = function () {
      tNow = parseFloat(this.value);
      playing = false;
      document.getElementById('v-play').textContent = 'play';
    };
    var cbPerson = document.getElementById('v-person');
    if (cbPerson) {
      cbPerson.onchange = function () {
        showPerson = this.checked;
        applyCloudMode();
      };
    }
    var cbPose = document.getElementById('v-pose');
    if (cbPose) {
      showPose = cbPose.checked;
      cbPose.onchange = function () {
        showPose = this.checked;
        if (pose) pose.frame = -1;
      };
    }
    requestAnimationFrame(tick);
  };
})();
