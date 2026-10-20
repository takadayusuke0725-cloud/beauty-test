// ==UserScript==
// @name         FakeCamTest       テスト映像差し込み（実験用）
// @description  カメラの代わりにテスト映像を渡す実験。顔加工はしません。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalled) return;
  window.__fakeCamInstalled = true;

  var md = navigator.mediaDevices;
  if (!md || !md.getUserMedia) return;

  var state = { calls: 0, last: '待機中' };
  var origGUM = md.getUserMedia.bind(md);
  var origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

  // ---- 画面の左下に小さな表示を出す（動作確認用） ----
  var badge = null;
  function renderBadge() {
    if (!document.body) return;
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText =
        'position:fixed;left:4px;bottom:4px;z-index:2147483647;' +
        'background:rgba(0,0,0,.75);color:#0f0;font:12px sans-serif;' +
        'padding:4px 8px;border-radius:6px;pointer-events:none;';
    }
    if (!badge.isConnected) document.body.appendChild(badge);
    badge.textContent = '実験スクリプト: ' + state.last + '（要求' + state.calls + '回）';
  }
  function setStatus(t) {
    state.last = t;
    renderBadge();
  }
  document.addEventListener('DOMContentLoaded', renderBadge);

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

  // ---- テスト映像づくり ----
  function makeFakeStream(w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
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

  // ---- カメラ要求をテスト映像に差し替え ----
  md.getUserMedia = function (constraints) {
    if (!constraints || !constraints.video) return origGUM(constraints);
    state.calls++;
    var v = constraints.video;
    var w = 1280;
    var h = 720;
    if (typeof v === 'object') {
      w = clamp(pickNum(v.width, 1280));
      h = clamp(pickNum(v.height, 720));
    }
    var fake = makeFakeStream(w, h);
    if (!constraints.audio) {
      setStatus('テスト映像を渡した');
      return Promise.resolve(fake);
    }
    return origGUM({ audio: constraints.audio })
      .then(function (a) {
        a.getAudioTracks().forEach(function (t) {
          fake.addTrack(t);
        });
        setStatus('テスト映像＋マイクを渡した');
        return fake;
      })
      .catch(function () {
        setStatus('テスト映像のみ（マイク失敗）');
        return fake;
      });
  };

  // ---- カメラ一覧に「テストカメラ」を足す（本物がない場合のみ） ----
  if (origEnum) {
    md.enumerateDevices = function () {
      return origEnum().then(function (list) {
        var has = list.some(function (d) {
          return d.kind === 'videoinput';
        });
        if (has) return list;
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
      });
    };
  }
})();
