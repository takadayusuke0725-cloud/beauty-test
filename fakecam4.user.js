// ==UserScript==
// @name         FakeCamDiagV4
// @description  カメラの通し方を3モードで比べる診断用（V4）。0本物そのまま／1テスト映像／2テスト映像＋本物の属性。顔加工はしません。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV4) return;
  window.__fakeCamInstalledV4 = true;

  var t0 = Date.now();
  var logs = [];
  var MAX = 60;
  var isOpen = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var btn = null;
  var seen = {};

  // ---- モード（0本物そのまま／1テスト映像／2テスト映像＋本物の属性）----
  var KEY = 'fakecam_v4_mode';
  var MODE_NAMES = ['0:本物そのまま', '1:テスト映像', '2:テスト映像＋本物の属性'];
  var mode = 0;
  try {
    var saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved >= 0 && saved <= 2) mode = saved;
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
      return '映像' + s.getVideoTracks().length + '本／音声' + s.getAudioTracks().length + '本／active=' + s.active;
    } catch (e) {
      return '(MediaStreamではない)';
    }
  }
  function render() {
    if (!panel) return;
    head.textContent =
      '診断V4 モード' + MODE_NAMES[mode] + '（要求' + calls + '回）' + (isOpen ? ' ▼' : ' ▲タップで開く');
    body.style.display = isOpen ? 'block' : 'none';
    btn.style.display = isOpen ? 'block' : 'none';
    if (isOpen) {
      body.textContent = logs.join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }
  function log(msg) {
    logs.push(ts() + short(msg, 150));
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
        'display:none;margin:4px 0;max-height:45vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      btn = document.createElement('button');
      btn.textContent = 'モード切替 0→1→2（切替後に再読み込み）';
      btn.style.cssText = 'display:none;font-size:11px;padding:4px 6px;margin:2px 0;';
      btn.addEventListener('click', function () {
        var next = (mode + 1) % 3;
        try {
          localStorage.setItem(KEY, String(next));
        } catch (e) {}
        mode = next;
        log('モードを ' + MODE_NAMES[mode] + ' にした。ページを再読み込みしてください');
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

  log('V4起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位') + '／モード' + MODE_NAMES[mode]);

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

  // ---- 許可状態の問い合わせを記録 ----
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var origQ = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = function (desc) {
        var name = desc && desc.name;
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

  // ---- video要素への映像セットと再生を記録 ----
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
              el.addEventListener(
                'error',
                function () {
                  log('video要素でエラー');
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
  try {
    var origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      var el = this;
      var r;
      try {
        r = origPlay.apply(el, arguments);
      } catch (e) {
        log('video.play 例外 ' + (e && e.name));
        throw e;
      }
      if (r && r.then) {
        r.then(
          function () {
            log('video.play 成功 ' + el.videoWidth + 'x' + el.videoHeight);
          },
          function (e) {
            log('video.play 失敗 ' + (e && e.name));
          }
        );
      }
      return r;
    };
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

  // ---- 画面上のvideo要素の点検 ----
  function scanVideos(tag) {
    try {
      var vs = document.querySelectorAll('video');
      var withSrc = 0;
      var sizes = [];
      for (var i = 0; i < vs.length; i++) {
        if (vs[i].srcObject) {
          withSrc++;
          sizes.push(vs[i].videoWidth + 'x' + vs[i].videoHeight);
        }
      }
      log(tag + ' video要素' + vs.length + '個／映像つき' + withSrc + '個 ' + sizes.join(','));
    } catch (e) {}
  }
  setTimeout(function () {
    scanVideos('8秒後');
  }, 8000);
  setTimeout(function () {
    scanVideos('15秒後');
  }, 15000);

  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) {
    log('mediaDevicesが見つからない');
    return;
  }

  var origGUM = md.getUserMedia.bind(md);
  var origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

  // ---- トラックの呼ばれ方を記録 ----
  var TRACK_FUNCS = [
    'getSettings',
    'getCapabilities',
    'getConstraints',
    'applyConstraints',
    'stop',
    'clone',
    'addEventListener'
  ];
  function wrapTrack(track, tag) {
    TRACK_FUNCS.forEach(function (name) {
      var o = track[name];
      if (typeof o !== 'function') {
        log(tag + ' ' + name + 'は存在しない');
        return;
      }
      track[name] = function () {
        var extra = name === 'addEventListener' ? ' ' + arguments[0] : '';
        var key = tag + name + extra;
        seen[key] = (seen[key] || 0) + 1;
        var quiet = seen[key] > 2;
        var r;
        try {
          r = o.apply(track, arguments);
        } catch (e) {
          log(tag + ' ' + name + extra + ' で例外 ' + (e && e.name));
          throw e;
        }
        if (!quiet) {
          if (name === 'getSettings') log(tag + ' getSettings → ' + safeJson(r));
          else log(tag + ' ' + name + extra + ' 呼ばれた');
        }
        return r;
      };
    });
  }
  function wrapStream(s, tag) {
    try {
      s.getVideoTracks().forEach(function (t) {
        wrapTrack(t, tag);
      });
    } catch (e) {}
  }
  function setLabel(track, text) {
    try {
      Object.defineProperty(track, 'label', { value: text, configurable: true });
    } catch (e) {}
  }

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

  // ---- テスト映像づくり（V2・V3と同じ。名札は後で付ける）----
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
    return stream;
  }

  // ---- モード2用：本物のカメラの属性を一度だけ読む（映像は使わず、すぐ止める）----
  function getRealInfo() {
    return origGUM({ video: true }).then(
      function (s) {
        var t = s.getVideoTracks()[0];
        var info = { label: '', settings: {}, caps: null };
        try {
          info.label = t.label;
        } catch (e) {}
        try {
          info.settings = t.getSettings();
        } catch (e) {}
        try {
          if (t.getCapabilities) info.caps = t.getCapabilities();
        } catch (e) {}
        s.getTracks().forEach(function (x) {
          x.stop();
        });
        log('本物の属性を読んだ label=' + info.label + ' settings=' + safeJson(info.settings));
        return info;
      },
      function (e) {
        log('本物の属性が読めない ' + (e && e.name));
        return null;
      }
    );
  }
  function applyInfo(track, info, w, h, reqVideo) {
    setLabel(track, info.label || 'Test Camera');
    var s = {};
    for (var k in info.settings) s[k] = info.settings[k];
    s.width = w;
    s.height = h;
    track.getSettings = function () {
      var c = {};
      for (var k2 in s) c[k2] = s[k2];
      return c;
    };
    if (info.caps) {
      track.getCapabilities = function () {
        return info.caps;
      };
    }
    track.getConstraints = function () {
      return typeof reqVideo === 'object' ? reqVideo : {};
    };
  }

  // ---- カメラ要求の処理（モードで分岐）----
  md.getUserMedia = function (constraints) {
    calls++;
    var n = calls;
    log('#' + n + ' 要求 ' + safeJson(constraints));
    var wantVideo = constraints && constraints.video;
    if (!wantVideo || mode === 0) {
      return origGUM(constraints).then(
        function (s) {
          log('#' + n + ' 本物を返した ' + describe(s));
          wrapStream(s, '本物映像');
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
    var vt = fake.getVideoTracks()[0];
    setLabel(vt, 'Test Camera');
    var infoP = mode === 2 ? getRealInfo() : Promise.resolve(null);
    return infoP.then(function (info) {
      if (info) applyInfo(vt, info, w, h, v);
      wrapTrack(vt, 'テスト映像');
      if (!constraints.audio) {
        log('#' + n + ' テスト映像を返した ' + describe(fake));
        return fake;
      }
      return origGUM({ audio: constraints.audio }).then(
        function (a) {
          a.getAudioTracks().forEach(function (t) {
            fake.addTrack(t);
          });
          log('#' + n + ' テスト映像＋マイクを返した ' + describe(fake));
          return fake;
        },
        function (e) {
          log('#' + n + ' マイク失敗 ' + (e && e.name) + '／テスト映像のみ返した');
          return fake;
        }
      );
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
          seen.enumCount = (seen.enumCount || 0) + 1;
          if (seen.enumCount <= 2) log('enumerateDevices: カメラ' + vc + '／マイク' + ac);
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
