// ==UserScript==
// @name         FakeCamDiagV3
// @description  Stripchatがカメラについて何を調べているかを記録して画面に表示する診断用（V3）。顔加工はしません。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV3) return;
  window.__fakeCamInstalledV3 = true;

  var t0 = Date.now();
  var logs = [];
  var MAX = 40;
  var isOpen = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var btn = null;

  // ---- 偽装の切り替え（再読み込みで反映）----
  var KEY = 'fakecam_v3_spoof';
  var spoof = false;
  try {
    spoof = localStorage.getItem(KEY) === '1';
  } catch (e) {}

  // ---- 記録と表示 ----
  function ts() {
    return ((Date.now() - t0) / 1000).toFixed(1) + 's ';
  }
  function short(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function safeJson(o) {
    try {
      return JSON.stringify(o);
    } catch (e) {
      return '(JSON化できず)';
    }
  }
  function describe(s) {
    try {
      return '映像' + s.getVideoTracks().length + '本／音声' + s.getAudioTracks().length + '本';
    } catch (e) {
      return '(MediaStreamではない)';
    }
  }
  function render() {
    if (!panel) return;
    head.textContent =
      '診断V3（要求' + calls + '回／記録' + logs.length + '件／偽装:' + (spoof ? 'ON' : 'OFF') + '）' +
      (isOpen ? ' ▼' : ' ▲タップで開く');
    body.style.display = isOpen ? 'block' : 'none';
    btn.style.display = isOpen ? 'block' : 'none';
    if (isOpen) {
      body.textContent = logs.join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }
  function log(msg) {
    logs.push(ts() + short(msg, 140));
    if (logs.length > MAX) logs.shift();
    render();
  }
  function ensurePanel() {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement('div');
      panel.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:2147483647;max-width:96vw;' +
        'background:rgba(0,0,0,.88);color:#0f0;font:11px/1.35 sans-serif;' +
        'padding:4px 8px;border-radius:6px;';
      head = document.createElement('div');
      head.style.cssText = 'font-weight:bold;padding:2px 0;';
      head.addEventListener('click', function () {
        isOpen = !isOpen;
        render();
      });
      body = document.createElement('pre');
      body.style.cssText =
        'display:none;margin:4px 0;max-height:38vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      btn = document.createElement('button');
      btn.textContent = '偽装の切り替え（切り替え後に再読み込み）';
      btn.style.cssText = 'display:none;font-size:11px;padding:4px 6px;margin:2px 0;';
      btn.addEventListener('click', function () {
        spoof = !spoof;
        try {
          localStorage.setItem(KEY, spoof ? '1' : '0');
        } catch (e) {}
        log('偽装を' + (spoof ? 'ONにした' : 'OFFにした') + '。ページを再読み込みしてください');
      });
      panel.appendChild(head);
      panel.appendChild(body);
      panel.appendChild(btn);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    render();
  }
  setInterval(ensurePanel, 500);
  document.addEventListener('DOMContentLoaded', ensurePanel);

  log('V3起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位') + '／偽装:' + (spoof ? 'ON' : 'OFF'));

  // ---- エラーの記録 ----
  window.addEventListener('error', function (e) {
    log('エラー: ' + (e && e.message));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    var t = r && (r.name || r.message) ? r.name + ' ' + (r.message || '') : String(r);
    log('未処理の拒否: ' + t);
  });
  ['error', 'warn'].forEach(function (k) {
    var orig = console[k];
    console[k] = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length && i < 3; i++) {
          var a = arguments[i];
          parts.push(a && a.message ? a.message : typeof a === 'object' ? '[object]' : String(a));
        }
        var m = parts.join(' ');
        if (/camera|media|permission|denied|NotAllowed|stream|device/i.test(m)) {
          log('console.' + k + ': ' + m);
        }
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  // ---- 許可状態の問い合わせを記録（偽装ONならカメラはgrantedを返す）----
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var origQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (desc) {
        var name = desc && desc.name;
        if (spoof && name === 'camera') {
          log('permissions.query(camera) → 偽装でgrantedを返した');
          return Promise.resolve({
            name: 'camera',
            state: 'granted',
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () {
              return false;
            }
          });
        }
        return origQ(desc).then(
          function (r) {
            log('permissions.query(' + name + ') = ' + r.state);
            return r;
          },
          function (e) {
            log('permissions.query(' + name + ') 失敗 ' + (e && e.name));
            throw e;
          }
        );
      };
    }
  } catch (e) {}

  // ---- video要素への映像セットを記録 ----
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (d && d.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          try {
            if (v) {
              log('video.srcObject設定 ' + describe(v));
              var el = this;
              el.addEventListener(
                'loadedmetadata',
                function () {
                  log('video読み込み ' + el.videoWidth + 'x' + el.videoHeight);
                },
                { once: true }
              );
            }
          } catch (e) {}
          return d.set.call(this, v);
        }
      });
    }
  } catch (e) {}

  // ---- WebRTC送信への追加を記録（配信開始は押さないので通常は出ない）----
  try {
    var P = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (P && P.prototype.addTrack) {
      var origAdd = P.prototype.addTrack;
      P.prototype.addTrack = function (track) {
        try {
          log('WebRTC送信に追加: ' + (track && track.kind));
        } catch (e) {}
        return origAdd.apply(this, arguments);
      };
    }
  } catch (e) {}

  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    log('mediaDevicesが見つからない');
    return;
  }

  var origGUM = md.getUserMedia.bind(md);
  var origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

  // ---- 数値の読み取り ----
  function pickNum(v, dflt) {
    if (typeof v === 'number') return v;
    if (v && typeof v === 'object') {
      if (typeof v.exact === 'number') return v.exact;
      if (typeof v.ideal === 'number') return v.ideal;
      if (typeof v.max === 'number') return v.max;
      if (typeof v.min === 'number') return v.min;
    }
    return dflt;
  }
  function clamp(n) {
    return Math.max(160, Math.min(1920, Math.round(n)));
  }

  // ---- テスト映像づくり（V2と同じ）----
  function makeFakeStream(w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText =
      'position:fixed;right:0;top:0;width:2px;height:2px;' +
      'opacity:0.01;pointer-events:none;z-index:-1;';
    var host = document.body || document.documentElement;
    host.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    var frame = 0;
    function draw() {
      frame++;
      ctx.fillStyle = 'hsl(' + ((frame * 2) % 360) + ',70%,45%)';
      ctx.fillRect(0, 0, w, h);
      var x = (Math.sin(frame / 20) * 0.4 + 0.5) * w;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, h * 0.5, Math.min(w, h) * 0.12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000000';
      ctx.font = 'bold ' + Math.round(h * 0.08) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('テスト映像', w / 2, h * 0.2);
      ctx.fillText('frame ' + frame, w / 2, h * 0.85);
    }
    draw();
    var timer = setInterval(draw, 33);
    var stream = canvas.captureStream(30);
    var track = stream.getVideoTracks()[0];
    var origStop = track.stop.bind(track);
    track.stop = function () {
      clearInterval(timer);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      origStop();
    };
    track.applyConstraints = function () {
      return Promise.resolve();
    };
    try {
      Object.defineProperty(track, 'label', { value: 'Test Camera' });
    } catch (e) {}
    return stream;
  }

  // ---- カメラ要求をテスト映像に差し替え（V2と同じ動き＋記録）----
  md.getUserMedia = function (constraints) {
    calls++;
    var n = calls;
    log('#' + n + ' getUserMedia要求 ' + safeJson(constraints));
    if (!constraints || !constraints.video) {
      return origGUM(constraints).then(
        function (s) {
          log('#' + n + ' 本物をそのまま返した ' + describe(s));
          return s;
        },
        function (e) {
          log('#' + n + ' 本物で失敗 ' + (e && e.name));
          throw e;
        }
      );
    }
    var v = constraints.video;
    var w = 1280;
    var h = 720;
    if (typeof v === 'object') {
      w = clamp(pickNum(v.width, 1280));
      h = clamp(pickNum(v.height, 720));
    }
    var fake = makeFakeStream(w, h);
    if (!constraints.audio) {
      log('#' + n + ' テスト映像を返した ' + describe(fake));
      return Promise.resolve(fake);
    }
    return origGUM({ audio: constraints.audio })
      .then(function (a) {
        a.getAudioTracks().forEach(function (t) {
          fake.addTrack(t);
        });
        log('#' + n + ' テスト映像＋マイクを返した ' + describe(fake));
        return fake;
      })
      .catch(function (e) {
        log('#' + n + ' マイク失敗 ' + (e && e.name) + '／テスト映像のみ返した');
        return fake;
      });
  };

  // ---- カメラ一覧の記録（本物のカメラがある場合は何も足さない）----
  if (origEnum) {
    md.enumerateDevices = function () {
      return origEnum().then(
        function (list) {
          var vc = 0;
          var ac = 0;
          list.forEach(function (x) {
            if (x.kind === 'videoinput') vc++;
            else if (x.kind === 'audioinput') ac++;
          });
          log('enumerateDevices: カメラ' + vc + '／マイク' + ac);
          if (vc > 0) return list;
          log('→テストカメラを一覧に追加した');
          return list.concat([
            {
              deviceId: 'fake-test-camera',
              groupId: 'fake',
              kind: 'videoinput',
              label: 'Test Camera',
              toJSON: function () {
                return this;
              }
            }
          ]);
        },
        function (e) {
          log('enumerateDevices失敗 ' + (e && e.name));
          throw e;
        }
      );
    };
  }
})();
