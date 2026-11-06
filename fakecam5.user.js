// ==UserScript==
// @name         FakeCamPipeV5
// @description  【実験V5】本物のカメラ→顔認識→覆い→出力を、Stripchatの確認画面で測る。覆いは仮の単色。配信開始は押さないこと。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV5) return;
  window.__fakeCamInstalledV5 = true;

  // ====== 調整値（測定してから決める） ======
  var COVER_SCALE = 1.18; // 覆いを顔の輪郭より何倍大きくするか
  var YAW_LIMIT = 0.2; // 顔の左右の向きの許容（0.5からのずれ）。超えたら待機画面
  var MIN_FACE_WIDTH = 0.08; // 顔の幅（画面比）がこれ未満なら待機画面
  var EDGE_MARGIN = 0.01; // 顔の輪郭が画面の端からこの比率以内なら待機画面
  var COVER_COLOR = '#d8b79c';

  // ====== 部品の場所（Google公式の案内どおり） ======
  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
  var MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  var MP_MODEL =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // 顔の外周の点の番号（MediaPipeの標準。目視で確認する）
  var FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
    149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
  ];

  var t0 = Date.now();
  var logs = [];
  var MAX = 80;
  var isOpen = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var seen = {};

  // ---- 測定の数字 ----
  var C = { out: 0, det: 0, A: 0, B: 0, loop: 0 };
  var S = { out: 0, det: 0, A: 0, B: 0, loop: 0, detAvg: 0, procAvg: 0, standbyPct: 0, lagCam: -1 };
  var detSamples = [];
  var procSamples = [];
  var runDetMax = 0;
  var runProcMax = 0;
  var lostCount = 0;
  var wasFace = false;
  var winFace = 0;
  var winStandby = 0;
  var reasonCount = {};
  var yawNow = 0;
  var lastTs = 0;
  var detErrCount = 0;

  // ---- 顔認識の部品 ----
  var landmarker = null;
  var mpFailed = false;
  var mpPromise = null;

  // ---- 動作中の処理（パイプライン） ----
  var curPipe = null;
  var curPipeP = null;
  var curKey = null;

  // ====== 記録と表示 ======
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
  function r0(n) {
    return Math.round(n);
  }
  function r1(n) {
    return Math.round(n * 10) / 10;
  }
  function errText(e) {
    if (!e) return '不明';
    return (e.name || '') + ' ' + (e.message || e);
  }
  function describe(s) {
    try {
      return '映像' + s.getVideoTracks().length + '本／音声' + s.getAudioTracks().length + '本／active=' + s.active;
    } catch (e) {
      return '(MediaStreamではない)';
    }
  }
  function updateHead() {
    if (!head) return;
    head.textContent =
      'V5診断（要求' + calls + '回）' + (isOpen ? ' ▼' : ' ▲タップで開く') + '\n' +
      '出力' + S.out + 'fps／検出' + S.det + 'fps／検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ')／処理' +
      r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ')\n' +
      '見失い' + lostCount + '回／待機' + S.standbyPct + '%／向き' + yawNow.toFixed(2) +
      (S.lagCam >= 0 ? '／カメラ遅れ' + r0(S.lagCam) + 'ms' : '');
  }
  function render() {
    if (!panel) return;
    updateHead();
    body.style.display = isOpen ? 'block' : 'none';
    if (isOpen) {
      body.textContent = logs.join('\n');
      body.scrollTop = body.scrollHeight;
    }
  }
  function log(msg) {
    logs.push(ts() + short(msg, 160));
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
      head.style.cssText = 'font-weight:bold;padding:2px 0;white-space:pre-wrap;';
      head.addEventListener('click', function () {
        isOpen = !isOpen;
        render();
      });
      body = document.createElement('pre');
      body.style.cssText =
        'display:none;margin:4px 0;max-height:42vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      panel.appendChild(head);
      panel.appendChild(body);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    render();
  }
  setInterval(ensurePanel, 500);
  document.addEventListener('DOMContentLoaded', ensurePanel);

  log('V5起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位'));

  // ====== エラーとページの制限の記録 ======
  window.addEventListener('error', function (e) {
    log('エラー: ' + (e && e.message));
  });
  window.addEventListener('unhandledrejection', function (e) {
    log('未処理の拒否: ' + errText(e && e.reason));
  });
  document.addEventListener('securitypolicyviolation', function (e) {
    log('制限に引っかかった: ' + e.violatedDirective + ' ' + short(e.blockedURI, 90));
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

  // ====== A：ページで使える機能と制限の点検 ======
  function envCheck() {
    try {
      log('WebAssembly: ' + (typeof WebAssembly !== 'undefined' ? 'あり' : 'なし'));
    } catch (e) {}
    try {
      var cv = document.createElement('canvas');
      log('WebGL2: ' + (cv.getContext('webgl2') ? 'あり' : 'なし') + '／OffscreenCanvas: ' + (typeof OffscreenCanvas !== 'undefined' ? 'あり' : 'なし'));
    } catch (e) {
      log('WebGL2の確認で例外 ' + errText(e));
    }
    try {
      log(
        'requestVideoFrameCallback: ' +
          (typeof HTMLVideoElement !== 'undefined' && HTMLVideoElement.prototype.requestVideoFrameCallback ? 'あり' : 'なし')
      );
    } catch (e) {}
    try {
      var u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
      var w = new Worker(u);
      w.onmessage = function () {
        log('Worker(blob): 動いた');
        w.terminate();
      };
      w.onerror = function () {
        log('Worker(blob): 失敗');
      };
    } catch (e) {
      log('Worker(blob): 作れない ' + errText(e));
    }
    try {
      fetch(location.href, { credentials: 'same-origin' }).then(
        function (r) {
          var csp = r.headers.get('content-security-policy') || r.headers.get('content-security-policy-report-only');
          if (!csp) {
            log('CSP(ヘッダー): なし');
            return;
          }
          csp.split(';').forEach(function (d) {
            d = d.trim();
            if (/^(default-src|script-src|connect-src|worker-src|media-src)/.test(d)) log('CSP ' + short(d, 150));
          });
        },
        function (e) {
          log('CSPの確認に失敗 ' + errText(e));
        }
      );
    } catch (e) {}
    [['部品(JS)', MP_MODULE], ['モデル', MP_MODEL]].forEach(function (p) {
      try {
        fetch(p[1], { method: 'HEAD' }).then(
          function (r) {
            log('取得テスト ' + p[0] + ': ' + r.status + ' 大きさ' + (r.headers.get('content-length') || '不明'));
          },
          function (e) {
            log('取得テスト ' + p[0] + ': 失敗 ' + errText(e));
          }
        );
      } catch (e) {
        log('取得テスト ' + p[0] + ': 例外 ' + errText(e));
      }
    });
  }
  envCheck();

  // ====== 顔認識の部品の読み込み ======
  function tryCreate(mod, fileset, delegate) {
    return mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MP_MODEL, delegate: delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false
    }).then(function (lm) {
      log('顔認識を作成 delegate=' + delegate);
      return lm;
    });
  }
  function loadMediaPipe() {
    if (mpPromise) return mpPromise;
    var tl = performance.now();
    var modP = window.__mpTestStub ? Promise.resolve(window.__mpTestStub) : import(MP_MODULE);
    mpPromise = modP
      .then(function (mod) {
        log('部品(JS)の読み込み成功 ' + r0(performance.now() - tl) + 'ms');
        return mod.FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) {
          log('wasmの準備OK ' + r0(performance.now() - tl) + 'ms');
          return tryCreate(mod, fileset, 'GPU').catch(function (e) {
            log('GPUで失敗(' + short(errText(e), 60) + ')→CPUで再試行');
            return tryCreate(mod, fileset, 'CPU');
          });
        });
      })
      .then(
        function (lm) {
          landmarker = lm;
          log('顔認識の準備完了 ' + r0(performance.now() - tl) + 'ms');
          return lm;
        },
        function (e) {
          mpFailed = true;
          log('顔認識の準備に失敗: ' + short(errText(e), 120));
          throw e;
        }
      );
    mpPromise.catch(function () {});
    return mpPromise;
  }

  // ====== 画面に出す部品 ======
  function makeHiddenVideo() {
    var el = document.createElement('video');
    el.__v5 = true;
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    (document.body || document.documentElement).appendChild(el);
    return el;
  }
  function playQuiet(el, tag) {
    try {
      var pr = el.play();
      if (pr && pr.catch) {
        pr.catch(function (e) {
          log(tag + ' のplay失敗 ' + (e && e.name));
        });
      }
    } catch (e) {}
  }
  function countFrames(el, key, pipe) {
    if (!el.requestVideoFrameCallback) {
      log('requestVideoFrameCallbackなし(' + key + ')');
      return;
    }
    function cb() {
      if (pipe.stopped) return;
      C[key]++;
      el.requestVideoFrameCallback(cb);
    }
    el.requestVideoFrameCallback(cb);
  }
  function waitForSize(v, ms) {
    return new Promise(function (resolve) {
      var waited = 0;
      var id = setInterval(function () {
        waited += 50;
        if (v.videoWidth > 0 || waited >= ms) {
          clearInterval(id);
          resolve();
        }
      }, 50);
    });
  }

  // ====== 描く（待機画面／覆い） ======
  function drawStandby(ctx, w, h, reason) {
    ctx.fillStyle = '#222222';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#dddddd';
    ctx.font = 'bold ' + Math.round(Math.min(w, h) * 0.06) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('待機中', w / 2, h * 0.47);
    ctx.font = Math.round(Math.min(w, h) * 0.04) + 'px sans-serif';
    ctx.fillText('（' + reason + '）', w / 2, h * 0.55);
  }
  function drawCover(ctx, pts, w, h) {
    var cx = 0;
    var cy = 0;
    var i;
    for (i = 0; i < FACE_OVAL.length; i++) {
      cx += pts[FACE_OVAL[i]].x;
      cy += pts[FACE_OVAL[i]].y;
    }
    cx /= FACE_OVAL.length;
    cy /= FACE_OVAL.length;
    ctx.beginPath();
    for (i = 0; i < FACE_OVAL.length; i++) {
      var p = pts[FACE_OVAL[i]];
      var x = (cx + (p.x - cx) * COVER_SCALE) * w;
      var y = (cy + (p.y - cy) * COVER_SCALE) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = COVER_COLOR;
    ctx.fill();
    // 追従がわかるよう、仮の目と口を描く
    var fw = Math.abs(pts[454].x - pts[234].x) * w;
    var eyeL = pts.length >= 478 ? pts[468] : pts[33];
    var eyeR = pts.length >= 478 ? pts[473] : pts[263];
    ctx.fillStyle = '#222222';
    ctx.beginPath();
    ctx.arc(eyeL.x * w, eyeL.y * h, fw * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(eyeR.x * w, eyeR.y * h, fw * 0.035, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = Math.max(2, fw * 0.015);
    ctx.beginPath();
    ctx.moveTo(pts[61].x * w, pts[61].y * h);
    ctx.lineTo(pts[291].x * w, pts[291].y * h);
    ctx.stroke();
  }

  // 顔の向きや位置が危ないとき、理由を返す（問題なければnull）
  function checkPose(pts) {
    var i;
    for (i = 0; i < FACE_OVAL.length; i++) {
      var p = pts[FACE_OVAL[i]];
      if (p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN || p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN) return '画面の端';
    }
    var width = pts[454].x - pts[234].x;
    if (Math.abs(width) < MIN_FACE_WIDTH) return '顔が小さい/横向き';
    yawNow = (pts[1].x - pts[234].x) / width - 0.5;
    if (Math.abs(yawNow) > YAW_LIMIT) return '向きが大きい';
    return null;
  }

  function avgMax(a) {
    var s = 0;
    var m = 0;
    for (var i = 0; i < a.length; i++) {
      s += a[i];
      if (a[i] > m) m = a[i];
    }
    return [a.length ? s / a.length : 0, m];
  }

  // ====== 1コマの処理 ======
  function processFrame(pipe, now, meta) {
    var tStart = performance.now();
    var ctx = pipe.ctx;
    var w = pipe.w;
    var h = pipe.h;
    var reason = null;
    var pts = null;

    if (!landmarker) {
      reason = mpFailed ? '顔認識の部品なし' : '読み込み中';
    } else {
      var tDet = performance.now();
      var stamp = Math.max(lastTs + 1, Math.round(now));
      lastTs = stamp;
      var res = null;
      try {
        res = landmarker.detectForVideo(pipe.video, stamp);
      } catch (e) {
        reason = '検出エラー';
        detErrCount++;
        if (detErrCount <= 3) log('検出で例外 ' + short(errText(e), 100));
      }
      var dms = performance.now() - tDet;
      detSamples.push(dms);
      if (dms > runDetMax) runDetMax = dms;
      C.det++;
      if (!reason) {
        if (res && res.faceLandmarks && res.faceLandmarks.length > 0) pts = res.faceLandmarks[0];
        else reason = '顔を見失い';
      }
      if (pts) reason = checkPose(pts);
    }

    if (reason) {
      drawStandby(ctx, w, h, reason);
      reasonCount[reason] = (reasonCount[reason] || 0) + 1;
      winStandby++;
      if (wasFace && reason !== '読み込み中') lostCount++;
      wasFace = false;
    } else {
      ctx.drawImage(pipe.video, 0, 0, w, h);
      drawCover(ctx, pts, w, h);
      winFace++;
      wasFace = true;
    }
    if (pipe.trackB && pipe.trackB.requestFrame) {
      try {
        pipe.trackB.requestFrame();
      } catch (e) {}
    }
    C.out++;
    var proc = performance.now() - tStart;
    procSamples.push(proc);
    if (proc > runProcMax) runProcMax = proc;
    if (meta && typeof meta.captureTime === 'number') {
      S.lagCam = Math.max(0, performance.now() - meta.captureTime);
    }
  }

  function startLoop(pipe) {
    var v = pipe.video;
    function onFrame(now, meta) {
      if (pipe.stopped) return;
      try {
        processFrame(pipe, now, meta);
      } catch (e) {
        log('処理中の例外 ' + short(errText(e), 100));
      }
      schedule();
    }
    function schedule() {
      if (pipe.stopped) return;
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(onFrame);
      else requestAnimationFrame(function (n) {
        onFrame(n, null);
      });
    }
    schedule();
  }

  // ====== 送れるかの代用テスト（ページの中で送って受け取る） ======
  function startLoopback(pipe, stream) {
    try {
      var pc1 = new RTCPeerConnection();
      var pc2 = new RTCPeerConnection();
      pipe.pc1 = pc1;
      pipe.pc2 = pc2;
      pc1.onicecandidate = function (e) {
        if (e.candidate) pc2.addIceCandidate(e.candidate).catch(function () {});
      };
      pc2.onicecandidate = function (e) {
        if (e.candidate) pc1.addIceCandidate(e.candidate).catch(function () {});
      };
      pc1.onconnectionstatechange = function () {
        log('送受テスト 接続=' + pc1.connectionState);
      };
      pc2.ontrack = function (e) {
        var el = makeHiddenVideo();
        pipe.els.push(el);
        el.srcObject = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
        playQuiet(el, '受信video');
        countFrames(el, 'loop', pipe);
        log('送受テスト 受信を開始');
      };
      stream.getTracks().forEach(function (t) {
        pc1.addTrack(t, stream);
      });
      pc1
        .createOffer()
        .then(function (o) {
          return pc1.setLocalDescription(o).then(function () {
            return pc2.setRemoteDescription(o);
          });
        })
        .then(function () {
          return pc2.createAnswer();
        })
        .then(function (a) {
          return pc2.setLocalDescription(a).then(function () {
            return pc1.setRemoteDescription(a);
          });
        })
        .catch(function (e) {
          log('送受テスト失敗 ' + short(errText(e), 100));
        });
    } catch (e) {
      log('送受テストを作れない ' + short(errText(e), 100));
    }
  }
  function logPcStats(pipe) {
    if (!pipe.pc1 || !pipe.pc1.getStats) return;
    pipe.pc1.getStats().then(
      function (rep) {
        rep.forEach(function (r) {
          if (r.type === 'outbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
            log(
              '送信統計 fps=' + r.framesPerSecond + ' ' + r.frameWidth + 'x' + r.frameHeight + ' 符号化' + r.framesEncoded +
                ' 制限=' + (r.qualityLimitationReason || '-')
            );
          }
        });
      },
      function () {}
    );
  }

  // ====== パイプライン（本物のカメラ→顔認識→覆い→出力）の開始と停止 ======
  function logSummary(pipe, sec) {
    log(
      '【' + sec + '秒】出力' + S.out + ' 検出' + S.det + ' 検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ') 処理' +
        r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ') 見失い' + lostCount + ' 待機' + S.standbyPct +
        '% 受信A' + S.A + ' B' + S.B + ' 送受' + S.loop
    );
    log('待機の内訳 ' + safeJson(reasonCount));
    logPcStats(pipe);
  }
  function tickStats() {
    S.out = C.out;
    S.det = C.det;
    S.A = C.A;
    S.B = C.B;
    S.loop = C.loop;
    C.out = 0;
    C.det = 0;
    C.A = 0;
    C.B = 0;
    C.loop = 0;
    var d = avgMax(detSamples);
    var p = avgMax(procSamples);
    S.detAvg = d[0];
    S.procAvg = p[0];
    detSamples = [];
    procSamples = [];
    var tot = winFace + winStandby;
    S.standbyPct = tot ? Math.round((100 * winStandby) / tot) : 0;
    winFace = 0;
    winStandby = 0;
    updateHead();
  }

  function startPipeline(facing) {
    var pipe = { key: facing, stopped: false, active: 0, teardownTimer: null, timers: [], els: [] };
    var reqV = { facingMode: facing, width: { ideal: 960 }, height: { ideal: 720 } };
    return origGUM({ video: reqV })
      .then(function (rs) {
        pipe.realStream = rs;
        var rt = rs.getVideoTracks()[0];
        var info = { label: '', settings: {}, caps: null };
        try {
          info.label = rt.label;
        } catch (e) {}
        try {
          info.settings = rt.getSettings();
        } catch (e) {}
        try {
          if (rt.getCapabilities) info.caps = rt.getCapabilities();
        } catch (e) {}
        pipe.info = info;
        log('本物のカメラを開いた label=' + info.label + ' settings=' + safeJson(info.settings));
        var v = makeHiddenVideo();
        pipe.els.push(v);
        pipe.video = v;
        v.srcObject = rs;
        playQuiet(v, '本物video');
        return waitForSize(v, 4000);
      })
      .then(function () {
        var v = pipe.video;
        pipe.w = v.videoWidth || 720;
        pipe.h = v.videoHeight || 960;
        var canvas = document.createElement('canvas');
        canvas.width = pipe.w;
        canvas.height = pipe.h;
        canvas.style.cssText =
          'position:fixed;right:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
        (document.body || document.documentElement).appendChild(canvas);
        pipe.canvas = canvas;
        pipe.ctx = canvas.getContext('2d');
        drawStandby(pipe.ctx, pipe.w, pipe.h, '起動中');
        log('出力の大きさ ' + pipe.w + 'x' + pipe.h);

        // 出力方法の比較：A=自動30枚 / B=描くたびに手動で送る
        var sA = canvas.captureStream(30);
        var elA = makeHiddenVideo();
        pipe.els.push(elA);
        elA.srcObject = sA;
        playQuiet(elA, '受信A');
        countFrames(elA, 'A', pipe);
        var sB = canvas.captureStream(0);
        pipe.trackB = sB.getVideoTracks()[0];
        var elB = makeHiddenVideo();
        pipe.els.push(elB);
        elB.srcObject = sB;
        playQuiet(elB, '受信B');
        countFrames(elB, 'B', pipe);
        startLoopback(pipe, sA);

        startLoop(pipe);
        pipe.timers.push(setInterval(tickStats, 1000));
        [20, 60, 120, 300, 600, 900].forEach(function (sec) {
          pipe.timers.push(
            setTimeout(function () {
              if (!pipe.stopped) logSummary(pipe, sec);
            }, sec * 1000)
          );
        });
        loadMediaPipe();
        return pipe;
      });
  }

  function stopPipeline(pipe) {
    if (!pipe || pipe.stopped) return;
    pipe.stopped = true;
    if (pipe.teardownTimer) clearTimeout(pipe.teardownTimer);
    pipe.timers.forEach(function (id) {
      clearTimeout(id);
      clearInterval(id);
    });
    try {
      if (pipe.realStream)
        pipe.realStream.getTracks().forEach(function (t) {
          t.stop();
        });
    } catch (e) {}
    try {
      if (pipe.pc1) pipe.pc1.close();
      if (pipe.pc2) pipe.pc2.close();
    } catch (e) {}
    pipe.els.forEach(function (el) {
      try {
        el.srcObject = null;
        if (el.parentNode) el.parentNode.removeChild(el);
      } catch (e) {}
    });
    try {
      if (pipe.canvas && pipe.canvas.parentNode) pipe.canvas.parentNode.removeChild(pipe.canvas);
    } catch (e) {}
    if (curPipe === pipe) {
      curPipe = null;
      curPipeP = null;
      curKey = null;
    }
    log('パイプラインを止めた（本物のカメラも停止）');
  }
  function scheduleTeardown(pipe) {
    if (pipe.teardownTimer) clearTimeout(pipe.teardownTimer);
    pipe.teardownTimer = setTimeout(function () {
      if (pipe.active <= 0) stopPipeline(pipe);
    }, 5000);
  }
  function ensurePipeline(facing) {
    if (curPipe && !curPipe.stopped && curPipe.key === facing) {
      if (curPipe.teardownTimer) {
        clearTimeout(curPipe.teardownTimer);
        curPipe.teardownTimer = null;
      }
      return Promise.resolve(curPipe);
    }
    if (curPipeP && curKey === facing) return curPipeP;
    if (curPipe) stopPipeline(curPipe);
    curKey = facing;
    var p = startPipeline(facing).then(
      function (pipe) {
        curPipe = pipe;
        return pipe;
      },
      function (e) {
        if (curPipeP === p) {
          curPipeP = null;
          curKey = null;
        }
        throw e;
      }
    );
    curPipeP = p;
    return p;
  }

  // ====== mediaDevices の差し替え ======
  var md = navigator.mediaDevices;
  var origGUM = null;
  var origEnum = null;

  function getFacing(v) {
    if (v && typeof v === 'object' && v.facingMode) {
      var fm = v.facingMode;
      if (Array.isArray(fm)) fm = fm[0];
      if (fm && typeof fm === 'object') fm = fm.exact || fm.ideal;
      if (typeof fm === 'string') return fm;
    }
    return 'user';
  }
  function setLabel(track, text) {
    try {
      Object.defineProperty(track, 'label', { value: text, configurable: true });
    } catch (e) {}
  }
  function applyInfo(track, info, w, h, reqVideo) {
    setLabel(track, info.label || 'Camera');
    var s = {};
    for (var k in info.settings) s[k] = info.settings[k];
    s.width = w;
    s.height = h;
    s.aspectRatio = w / h;
    s.frameRate = 30;
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
    track.applyConstraints = function () {
      return Promise.resolve();
    };
  }
  var TRACK_FUNCS = ['getSettings', 'getCapabilities', 'getConstraints', 'applyConstraints', 'stop', 'clone', 'addEventListener'];
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
          if (name === 'getSettings') log(tag + ' getSettings → ' + short(safeJson(r), 100));
          else log(tag + ' ' + name + extra + ' 呼ばれた');
        }
        return r;
      };
    });
  }
  function makeOutStream(pipe) {
    var stream = pipe.canvas.captureStream(30);
    var track = stream.getVideoTracks()[0];
    pipe.active++;
    var origStop = track.stop.bind(track);
    var stopped = false;
    track.stop = function () {
      if (stopped) return;
      stopped = true;
      origStop();
      pipe.active--;
      if (pipe.active <= 0) scheduleTeardown(pipe);
    };
    return stream;
  }

  if (!md || !md.getUserMedia) {
    log('mediaDevicesが見つからない');
    return;
  }
  origGUM = md.getUserMedia.bind(md);
  origEnum = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

  md.getUserMedia = function (constraints) {
    calls++;
    var n = calls;
    log('#' + n + ' 要求 ' + short(safeJson(constraints), 110));
    var wantVideo = constraints && constraints.video;
    if (!wantVideo) {
      return origGUM(constraints).then(
        function (s) {
          log('#' + n + ' 本物を返した ' + describe(s));
          return s;
        },
        function (e) {
          log('#' + n + ' 失敗 ' + (e && e.name));
          throw e;
        }
      );
    }
    var v = constraints.video;
    return ensurePipeline(getFacing(v)).then(
      function (pipe) {
        var stream = makeOutStream(pipe);
        var vt = stream.getVideoTracks()[0];
        applyInfo(vt, pipe.info, pipe.w, pipe.h, v);
        wrapTrack(vt, 'V5出力');
        if (!constraints.audio) {
          log('#' + n + ' 加工映像を返した ' + describe(stream));
          return stream;
        }
        return origGUM({ audio: constraints.audio }).then(
          function (a) {
            a.getAudioTracks().forEach(function (t) {
              stream.addTrack(t);
            });
            log('#' + n + ' 加工映像＋マイクを返した ' + describe(stream));
            return stream;
          },
          function (e) {
            log('#' + n + ' マイク失敗 ' + (e && e.name) + '／映像のみ返した');
            return stream;
          }
        );
      },
      function (e) {
        log('#' + n + ' カメラを開けない ' + (e && e.name));
        throw e;
      }
    );
  };

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
          return list;
        },
        function (e) {
          log('enumerateDevices失敗 ' + (e && e.name));
          throw e;
        }
      );
    };
  }

  // ====== Stripchat側のvideo要素への映像セットを記録 ======
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (d && d.set) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          try {
            if (v && !this.__v5) {
              log('Stripchatのvideoに映像セット ' + describe(v));
              var el = this;
              el.addEventListener(
                'loadedmetadata',
                function () {
                  log('Stripchatのvideo読み込み ' + el.videoWidth + 'x' + el.videoHeight);
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

  function scanVideos(tag) {
    try {
      var vs = document.querySelectorAll('video');
      var total = 0;
      var withSrc = 0;
      var sizes = [];
      for (var i = 0; i < vs.length; i++) {
        if (vs[i].__v5) continue;
        total++;
        if (vs[i].srcObject) {
          withSrc++;
          sizes.push(vs[i].videoWidth + 'x' + vs[i].videoHeight);
        }
      }
      log(tag + ' Stripchatのvideo要素' + total + '個／映像つき' + withSrc + '個 ' + sizes.join(','));
    } catch (e) {}
  }
  setTimeout(function () {
    scanVideos('8秒後');
  }, 8000);
  setTimeout(function () {
    scanVideos('20秒後');
  }, 20000);
})();
