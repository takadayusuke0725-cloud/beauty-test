// ==UserScript==
// @name         FakeCamPipeV6
// @description  【実験V6】覆いの形の比較・向きの度数・主要パーツの被覆・待機切り替え・枚数の原因切り分けを、1回で測る。覆いは仮の単色。配信開始は押さないこと。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV6) return;
  window.__fakeCamInstalledV6 = true;

  // ====== 調整値 ======
  var COVER_SCALE = 1.0; // 覆いの倍率（V6：大きくしない）
  var YAW_LIMIT_DEG = 0; // 左右の向きの許容（度）。0＝制限なし（試験用）
  var MIN_FACE_WIDTH = 0; // 顔の幅（画面比）の下限。0＝制限なし（試験用）
  var EDGE_MARGIN = 0.01; // 顔の輪郭が画面の端からこの比率以内なら待機画面
  var COVER_COLOR = '#d8b79c'; // 36点の形の色
  var COVER_COLOR_HULL = '#c04040'; // 478点を包む形の色（はみ出し部分が赤く見える）
  var shapeMode = 2; // 0＝36点の形だけ／1＝478点を包む形だけ／2＝両方（赤＝包む形のはみ出し）
  var TS = typeof window.__v6TimeScale === 'number' && window.__v6TimeScale > 0 ? window.__v6TimeScale : 1; // 擬似環境の試験用。通常は1

  // ====== 部品の場所（Google公式の案内どおり） ======
  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
  var MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  var MP_MODEL =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // 顔の外周の点の番号（MediaPipeの標準。記憶ベースで未確認。目視で確認する）
  var FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
    149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
  ];

  // 主要パーツの点の番号（MediaPipeの標準。記憶ベースで未確認。目視で確認する）
  var PARTS = [
    { name: '目', ids: [33, 7, 163, 144, 145, 153, 154, 155, 133, 246, 161, 160, 159, 158, 157, 173, 263, 249, 390, 373, 374, 380, 381, 382, 362, 466, 388, 387, 386, 385, 384, 398] },
    { name: '眉', ids: [46, 53, 52, 65, 55, 70, 63, 105, 66, 107, 276, 283, 282, 295, 285, 300, 293, 334, 296, 336] },
    { name: '鼻', ids: [1, 2, 4, 5, 6, 19, 94, 98, 327, 168, 195, 197, 129, 358] },
    { name: '口', ids: [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409, 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 191, 80, 81, 82, 13, 312, 311, 310, 415] },
    { name: '頬', ids: [116, 117, 118, 119, 123, 147, 187, 205, 50, 101, 345, 346, 347, 348, 352, 376, 411, 425, 280, 330] }
  ];
  var KEYIDS = [];
  var KEYPART = [];
  (function () {
    for (var p = 0; p < PARTS.length; p++) {
      for (var q = 0; q < PARTS[p].ids.length; q++) {
        KEYIDS.push(PARTS[p].ids[q]);
        KEYPART.push(p);
      }
    }
  })();

  // ====== 試験の進行（画面の指示どおりに動く） ======
  var SEGS = [
    { sec: 150, text: '正面で動かず座る（枚数の原因切り分け中）', short: '正面静止(原因切り分け)' },
    { sec: 40, text: 'ゆっくり顔を左へ向ける→止まる所まで→正面へ戻す', short: '左へゆっくり' },
    { sec: 40, text: 'ゆっくり顔を右へ向ける→止まる所まで→正面へ戻す', short: '右へゆっくり' },
    { sec: 40, text: 'ゆっくり上を向く→正面→下を向く→正面', short: '上下ゆっくり' },
    { sec: 40, text: '左右に大きく斜め(45〜70度)。各5秒止める', short: '大きく斜めで静止' },
    { sec: 30, text: '速く動く（左右・上下を素早く）', short: '速い動き' },
    { sec: 30, text: '手で顔を隠す→外す（3回）', short: '手で隠す' },
    { sec: 60, text: '部屋を暗くして正面で座る（暗いまま）', short: '暗い' },
    { sec: 600, text: '明るく戻し、普通に話しながら動く（連続運転・熱）', short: '連続運転' }
  ];
  var PHASES = [
    { name: '全部オン(V5と同じ)' },
    { name: '送受テスト停止' },
    { name: 'さらにB受信停止' },
    { name: 'さらにA受信停止(検出と描画のみ)' },
    { name: '全部オン(再確認)' }
  ];
  var PHASE_SEC = 30;

  var t0 = Date.now();
  var logs = [];
  var MAX = 600;
  var isOpen = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var seen = {};
  var promptText = '';
  var promptEnd = 0;

  // ---- 測定の数字 ----
  var C = { out: 0, det: 0, A: 0, B: 0, loop: 0 };
  var S = { out: 0, det: 0, A: 0, B: 0, loop: 0, detAvg: 0, procAvg: 0, standbyPct: 0, lagCam: -1, metAvg: 0 };
  var detSamples = [];
  var procSamples = [];
  var metSamples = [];
  var runDetMax = 0;
  var runProcMax = 0;
  var lostCount = 0;
  var wasFace = false;
  var winFace = 0;
  var winStandby = 0;
  var reasonCount = {};
  var lastTs = 0;
  var detErrCount = 0;
  var metErrCount = 0;

  // ---- 向き（度）----
  var yawM = null; // 行列から（左右）
  var pitchM = null; // 行列から（上下）
  var yawG = null; // 顔の点の奥行きから（左右。行列の符号の確認用）
  var pitchG = null;
  var layoutLogged = false;
  var agreeYaw = [0, 0]; // [一致, 不一致]（|向き|>15度のとき）
  var agreePitch = [0, 0];
  var lastAng = null;
  var lostInfo = null;
  var stopsN = 0;

  // ---- 角度別の記録 ----
  var BIN_EDGES = [15, 30, 45, 60, 75];
  var BIN_LABEL = ['0-15°', '15-30°', '30-45°', '45-60°', '60-75°', '75°以上'];
  function newBin() {
    return {
      n: 0, pin: [0, 0, 0, 0, 0], ptot: [0, 0, 0, 0, 0], minPct: 100, tipOut: 0,
      ratioSum: 0, ratioN: 0, ovChgSum: 0, ovChgMax: 0, huChgSum: 0, huChgMax: 0, chgN: 0,
      jRaw: 0, jRel: 0, jRelMax: 0, jN: 0
    };
  }
  var bins = [];
  (function () {
    for (var i = 0; i < 6; i++) bins.push(newBin());
  })();
  var prevKey = null;
  var prevAOv = 0;
  var prevAHu = 0;

  // ---- 区間・局面の集計 ----
  function newAcc() {
    return { frames: 0, standby: 0, secs: 0, out: 0, proc: 0, det: 0, A: 0, B: 0, loop: 0, lost: 0, mP: 0, mN: 0, gP: 0, gN: 0, pP: 0, pN: 0 };
  }
  var totAcc = newAcc();
  var curSeg = null;
  var curSegIdx = -1;
  var curPhase = null;
  var curPhaseIdx = -1;

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
  function r2(n) {
    return Math.round(n * 100) / 100;
  }
  function fa(v) {
    if (v === null || v === undefined || isNaN(v)) return '-';
    return (v >= 0 ? '+' : '') + r0(v);
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
  function angUse() {
    if (yawM !== null) return yawM;
    if (yawG !== null) return yawG;
    return 0;
  }
  var SHAPE_NAME = ['36点だけ', '478包みだけ', '両方(赤=包みのはみ出し)'];
  function updateHead() {
    if (!head) return;
    var pr = '';
    if (promptText) {
      var left = promptEnd ? Math.max(0, Math.round((promptEnd - performance.now()) / 1000)) : 0;
      pr = promptText + (promptEnd ? ' 残' + left + '秒' : '') + '\n';
    }
    head.textContent =
      pr +
      'V6（要求' + calls + '回）' + (isOpen ? ' ▼' : ' ▲タップで開く') + '\n' +
      '出力' + S.out + 'fps／検出' + S.det + 'fps／検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ')／処理' +
      r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ')／測定' + r1(S.metAvg) + 'ms\n' +
      '見失い' + lostCount + '回／待機' + S.standbyPct + '%' + (S.lagCam >= 0 ? '／カメラ遅れ' + r0(S.lagCam) + 'ms' : '') + '\n' +
      '向き 左右' + fa(yawM) + '°(行列)/' + fa(yawG) + '°(幾何) 上下' + fa(pitchM) + '°(行列)/' + fa(pitchG) + '°(幾何)';
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
    logs.push(ts() + short(msg, 260));
    if (logs.length > MAX) logs.shift();
    render();
  }
  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:0;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        ta.setSelectionRange(0, text.length);
      } catch (e) {}
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      log(ok ? 'ログをコピーした（代替方式）' : 'コピー失敗：ログ表示を開いて長押しで選ぶ');
    } catch (e) {
      log('コピー失敗 ' + errText(e));
    }
  }
  function copyLogs() {
    var text = logs.join('\n');
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            log('ログをコピーした（' + logs.length + '行）');
          },
          function () {
            fallbackCopy(text);
          }
        );
        return;
      }
    } catch (e) {}
    fallbackCopy(text);
  }
  function makeBtn(label, fn) {
    var b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'margin:2px 4px 2px 0;padding:3px 8px;font:11px sans-serif;color:#0f0;background:#143314;' +
      'border:1px solid #0f0;border-radius:4px;';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      try {
        fn(b);
      } catch (err) {
        log('ボタンの例外 ' + errText(err));
      }
    });
    return b;
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
      var row = document.createElement('div');
      row.appendChild(
        makeBtn('形:' + SHAPE_NAME[shapeMode], function (b) {
          shapeMode = (shapeMode + 1) % 3;
          b.textContent = '形:' + SHAPE_NAME[shapeMode];
          log('覆いの形を切り替え：' + SHAPE_NAME[shapeMode]);
        })
      );
      row.appendChild(
        makeBtn('集計を出す', function () {
          logBins('手動');
        })
      );
      row.appendChild(
        makeBtn('ログをコピー', function () {
          copyLogs();
        })
      );
      body = document.createElement('pre');
      body.style.cssText =
        'display:none;margin:4px 0;max-height:42vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      panel.appendChild(head);
      panel.appendChild(row);
      panel.appendChild(body);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    render();
  }
  setInterval(ensurePanel, 500);
  document.addEventListener('DOMContentLoaded', ensurePanel);

  log('V6起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位'));

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
      outputFacialTransformationMatrixes: true // V6：向き（度）を出すため
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
  function removeEl(pipe, el) {
    try {
      if (el.parentNode) el.parentNode.removeChild(el);
    } catch (e) {}
    var i = pipe.els.indexOf(el);
    if (i >= 0) pipe.els.splice(i, 1);
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
      if (pipe.stopped || el.__off) return;
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

  // ====== 計算（形・向き） ======
  function hull(P) {
    var a = P.slice().sort(function (p, q) {
      return p[0] - q[0] || p[1] - q[1];
    });
    var n = a.length;
    if (n < 3) return a;
    function cross(o, p, q) {
      return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    }
    var lo = [];
    var up = [];
    var i;
    for (i = 0; i < n; i++) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], a[i]) <= 0) lo.pop();
      lo.push(a[i]);
    }
    for (i = n - 1; i >= 0; i--) {
      while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], a[i]) <= 0) up.pop();
      up.push(a[i]);
    }
    lo.pop();
    up.pop();
    return lo.concat(up);
  }
  function polyArea(P) {
    var s = 0;
    var n = P.length;
    for (var i = 0; i < n; i++) {
      var j = (i + 1) % n;
      s += P[i][0] * P[j][1] - P[j][0] * P[i][1];
    }
    return Math.abs(s) / 2;
  }
  function inPoly(x, y, P) {
    var c = false;
    for (var i = 0, j = P.length - 1; i < P.length; j = i++) {
      var xi = P[i][0];
      var yi = P[i][1];
      var xj = P[j][0];
      var yj = P[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function scalePoly(P, cx, cy, k) {
    if (k === 1) return P;
    var out = [];
    for (var i = 0; i < P.length; i++) out.push([cx + (P[i][0] - cx) * k, cy + (P[i][1] - cy) * k]);
    return out;
  }
  function buildGeom(pts, w, h) {
    var i;
    var all = [];
    for (i = 0; i < pts.length; i++) all.push([pts[i].x * w, pts[i].y * h]);
    var ov = [];
    var cx = 0;
    var cy = 0;
    for (i = 0; i < FACE_OVAL.length; i++) {
      var q = all[FACE_OVAL[i]];
      ov.push(q);
      cx += q[0];
      cy += q[1];
    }
    cx /= FACE_OVAL.length;
    cy /= FACE_OVAL.length;
    var hu = hull(all);
    return {
      all: all,
      ov: scalePoly(ov, cx, cy, COVER_SCALE),
      hu: scalePoly(hu, cx, cy, COVER_SCALE)
    };
  }
  // 顔の変換行列から向き（度）を出す。符号の向きは未確認（試験の区間で左右・上下を向いて確認する）
  function matInfo(res) {
    try {
      var ms = res && res.facialTransformationMatrixes;
      if (!ms || !ms.length) return null;
      var m = ms[0];
      var d = m && (m.data || m);
      if (!d || d.length < 16) return null;
      var colMajor =
        Math.abs(d[12]) + Math.abs(d[13]) + Math.abs(d[14]) >= Math.abs(d[3]) + Math.abs(d[7]) + Math.abs(d[11]);
      var R = function (r, c) {
        return colMajor ? d[c * 4 + r] : d[r * 4 + c];
      };
      var s = Math.sqrt(R(0, 0) * R(0, 0) + R(1, 0) * R(1, 0) + R(2, 0) * R(2, 0)) || 1;
      var yaw = (Math.atan2(R(0, 2), R(2, 2)) * 180) / Math.PI;
      var sp = -R(1, 2) / s;
      if (sp > 1) sp = 1;
      if (sp < -1) sp = -1;
      var pitch = (Math.asin(sp) * 180) / Math.PI;
      return { yaw: yaw, pitch: pitch, colMajor: colMajor };
    } catch (e) {
      return null;
    }
  }
  // 顔の点の奥行き(z)から向きを出す（行列の確認用の別方式）
  function geoAngles(pts, aspect) {
    var a = pts[454];
    var b = pts[234];
    var t = pts[10];
    var c = pts[152];
    if (!a || !b || !t || !c) return [null, null];
    if (typeof a.z !== 'number' || typeof b.z !== 'number' || typeof t.z !== 'number' || typeof c.z !== 'number') return [null, null];
    var yaw = (Math.atan2(a.z - b.z, a.x - b.x) * 180) / Math.PI;
    var pitch = (Math.atan2(c.z - t.z, (c.y - t.y) * aspect) * 180) / Math.PI;
    return [yaw, pitch];
  }
  function updatePose(res, pts, w, h) {
    var m = matInfo(res);
    if (m) {
      yawM = m.yaw;
      pitchM = m.pitch;
      if (!layoutLogged) {
        layoutLogged = true;
        log('向きの行列：' + (m.colMajor ? '列ごとの並び' : '行ごとの並び') + 'と判定');
      }
    } else {
      yawM = null;
      pitchM = null;
    }
    var g = geoAngles(pts, h / w);
    yawG = g[0];
    pitchG = g[1];
    if (yawM !== null && yawG !== null && Math.abs(yawM) > 15) {
      if (yawM * yawG > 0) agreeYaw[0]++;
      else agreeYaw[1]++;
    }
    if (pitchM !== null && pitchG !== null && Math.abs(pitchM) > 10) {
      if (pitchM * pitchG > 0) agreePitch[0]++;
      else agreePitch[1]++;
    }
  }
  function upMax(a) {
    if (yawM !== null) {
      if (yawM > a.mP) a.mP = yawM;
      if (-yawM > a.mN) a.mN = -yawM;
    }
    if (yawG !== null) {
      if (yawG > a.gP) a.gP = yawG;
      if (-yawG > a.gN) a.gN = -yawG;
    }
    if (pitchM !== null) {
      if (pitchM > a.pP) a.pP = pitchM;
      if (-pitchM > a.pN) a.pN = -pitchM;
    }
  }
  function binOf(a) {
    for (var i = 0; i < BIN_EDGES.length; i++) if (a < BIN_EDGES[i]) return i;
    return BIN_EDGES.length;
  }

  // 顔の位置が危ないとき、理由を返す（問題なければnull）。V6は「画面の端」だけが標準
  function checkPose(pts) {
    var i;
    for (i = 0; i < FACE_OVAL.length; i++) {
      var p = pts[FACE_OVAL[i]];
      if (p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN || p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN) return '画面の端';
    }
    if (MIN_FACE_WIDTH > 0) {
      var width = pts[454].x - pts[234].x;
      if (Math.abs(width) < MIN_FACE_WIDTH) return '顔が小さい/横向き';
    }
    if (YAW_LIMIT_DEG > 0 && Math.abs(angUse()) > YAW_LIMIT_DEG) return '向きが大きい';
    return null;
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
  function fillPoly(ctx, P, color) {
    ctx.beginPath();
    for (var i = 0; i < P.length; i++) {
      if (i === 0) ctx.moveTo(P[i][0], P[i][1]);
      else ctx.lineTo(P[i][0], P[i][1]);
    }
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }
  function drawCover(ctx, pts, w, h, g) {
    if (shapeMode === 0) {
      fillPoly(ctx, g.ov, COVER_COLOR);
    } else if (shapeMode === 1) {
      fillPoly(ctx, g.hu, COVER_COLOR);
    } else {
      fillPoly(ctx, g.hu, COVER_COLOR_HULL);
      fillPoly(ctx, g.ov, COVER_COLOR);
    }
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

  // ====== 角度別の測定（主要パーツの被覆・覆いの安定・点のぶれ） ======
  function recordMetrics(g) {
    var ang = Math.abs(angUse());
    var B = bins[binOf(ang)];
    B.n++;
    var k;
    var allIn = 0;
    var cur = [];
    for (k = 0; k < KEYIDS.length; k++) {
      var q = g.all[KEYIDS[k]];
      cur.push(q);
      var pi = KEYPART[k];
      B.ptot[pi]++;
      if (inPoly(q[0], q[1], g.ov)) {
        B.pin[pi]++;
        allIn++;
      } else if (KEYIDS[k] === 1) {
        B.tipOut++;
      }
    }
    var pct = (100 * allIn) / KEYIDS.length;
    if (pct < B.minPct) B.minPct = pct;
    var aOv = polyArea(g.ov);
    var aHu = polyArea(g.hu);
    if (aOv > 0) {
      B.ratioSum += aHu / aOv;
      B.ratioN++;
    }
    if (prevKey && prevAOv > 0 && prevAHu > 0) {
      var c1 = (100 * Math.abs(aOv - prevAOv)) / prevAOv;
      var c2 = (100 * Math.abs(aHu - prevAHu)) / prevAHu;
      B.ovChgSum += c1;
      B.huChgSum += c2;
      if (c1 > B.ovChgMax) B.ovChgMax = c1;
      if (c2 > B.huChgMax) B.huChgMax = c2;
      B.chgN++;
      var n = cur.length;
      var sx = 0;
      var sy = 0;
      var i;
      for (i = 0; i < n; i++) {
        sx += cur[i][0] - prevKey[i][0];
        sy += cur[i][1] - prevKey[i][1];
      }
      var mx = sx / n;
      var my = sy / n;
      var raw = 0;
      var rel = 0;
      for (i = 0; i < n; i++) {
        var dx = cur[i][0] - prevKey[i][0];
        var dy = cur[i][1] - prevKey[i][1];
        raw += Math.sqrt(dx * dx + dy * dy);
        var rx = dx - mx;
        var ry = dy - my;
        rel += Math.sqrt(rx * rx + ry * ry);
      }
      B.jRaw += raw / n;
      B.jRel += rel / n;
      if (rel / n > B.jRelMax) B.jRelMax = rel / n;
      B.jN++;
    }
    prevKey = cur;
    prevAOv = aOv;
    prevAHu = aHu;
  }
  function logBins(tag) {
    log('━ 角度別の集計（' + tag + '）。角度＝左右の向きの絶対値(行列。なければ幾何) ━');
    for (var i = 0; i < bins.length; i++) {
      var B = bins[i];
      if (!B.n) {
        log(BIN_LABEL[i] + ': 0コマ');
        continue;
      }
      var parts = [];
      for (var p = 0; p < PARTS.length; p++) {
        parts.push(PARTS[p].name + (B.ptot[p] ? r0((100 * B.pin[p]) / B.ptot[p]) : '-'));
      }
      log(
        BIN_LABEL[i] + ' ' + B.n + 'コマ｜36点の形に入った率(%) ' + parts.join(' ') + '｜全体の最小' + r0(B.minPct) +
          '%｜鼻先が外' + B.tipOut + 'コマ'
      );
      log(
        '　形の大きさ(478包み÷36点) ' + (B.ratioN ? r2(B.ratioSum / B.ratioN) : '-') +
          '｜1コマの面積変化 36点 平均' + (B.chgN ? r1(B.ovChgSum / B.chgN) : '-') + '%/最大' + r0(B.ovChgMax) +
          '、478包み 平均' + (B.chgN ? r1(B.huChgSum / B.chgN) : '-') + '%/最大' + r0(B.huChgMax) +
          '｜点のぶれ 全体' + (B.jN ? r1(B.jRaw / B.jN) : '-') + 'px、動きを除いた相対' + (B.jN ? r1(B.jRel / B.jN) : '-') +
          'px(最大' + r1(B.jRelMax) + ')'
      );
    }
    log(
      '符号の一致（行列と幾何）左右 一致' + agreeYaw[0] + '/不一致' + agreeYaw[1] + '、上下 一致' + agreePitch[0] +
        '/不一致' + agreePitch[1] + '｜全体の最大向き(行列) 左右+' + r0(totAcc.mP) + '/-' + r0(totAcc.mN) +
        ' 上下+' + r0(totAcc.pP) + '/-' + r0(totAcc.pN) + '｜(幾何) 左右+' + r0(totAcc.gP) + '/-' + r0(totAcc.gN) +
        '｜止まった回数' + stopsN
    );
  }

  // ====== 1コマの処理 ======
  function processFrame(pipe, now, meta) {
    var tStart = performance.now();
    var ctx = pipe.ctx;
    var w = pipe.w;
    var h = pipe.h;
    var reason = null;
    var pts = null;
    var res = null;
    var g = null;

    if (!landmarker) {
      reason = mpFailed ? '顔認識の部品なし' : '読み込み中';
    } else {
      var tDet = performance.now();
      var stamp = Math.max(lastTs + 1, Math.round(now));
      lastTs = stamp;
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
      if (pts) {
        updatePose(res, pts, w, h);
        reason = checkPose(pts);
      }
    }

    if (!reason) {
      try {
        g = buildGeom(pts, w, h);
      } catch (e) {
        reason = '形の計算エラー';
        log('形の計算で例外 ' + short(errText(e), 100));
      }
    }

    if (reason) {
      drawStandby(ctx, w, h, reason);
      reasonCount[reason] = (reasonCount[reason] || 0) + 1;
      winStandby++;
      totAcc.standby++;
      if (curSeg) curSeg.standby++;
      if (wasFace && reason !== '読み込み中') {
        lostCount++;
        if (curSeg) curSeg.lost++;
        if (reason === '顔を見失い') stopsN++;
        lostInfo = { t: performance.now(), reason: reason, ang: lastAng };
      }
      wasFace = false;
      prevKey = null;
      prevAOv = 0;
      prevAHu = 0;
    } else {
      ctx.drawImage(pipe.video, 0, 0, w, h);
      drawCover(ctx, pts, w, h, g);
      winFace++;
      totAcc.frames++;
      if (curSeg) curSeg.frames++;
      if (lostInfo) {
        var a = lostInfo.ang;
        var dur = (performance.now() - lostInfo.t) / 1000;
        log(
          '停止(' + lostInfo.reason + ')→復帰 待機' + r2(dur) + '秒｜直前の向き(行列) 左右' + (a ? fa(a.yawM) : '-') +
            '° 上下' + (a ? fa(a.pitchM) : '-') + '°｜(幾何) 左右' + (a ? fa(a.yawG) : '-') + '° 上下' + (a ? fa(a.pitchG) : '-') + '°'
        );
        lostInfo = null;
      }
      wasFace = true;
      lastAng = { yawM: yawM, pitchM: pitchM, yawG: yawG, pitchG: pitchG };
      upMax(totAcc);
      if (curSeg) upMax(curSeg);
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

    // 測定（出力を描いた後に行う）
    if (g) {
      var tm = performance.now();
      try {
        recordMetrics(g);
      } catch (e) {
        metErrCount++;
        if (metErrCount <= 3) log('測定で例外 ' + short(errText(e), 100));
      }
      metSamples.push(performance.now() - tm);
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

  // ====== 計測用の受信（A・B）と、送れるかの代用テスト ======
  function attachA(pipe) {
    if (pipe.elA) return;
    var el = makeHiddenVideo();
    pipe.els.push(el);
    pipe.elA = el;
    el.srcObject = pipe.sA;
    playQuiet(el, '受信A');
    countFrames(el, 'A', pipe);
  }
  function detachA(pipe) {
    var el = pipe.elA;
    if (!el) return;
    el.__off = true;
    try {
      el.srcObject = null;
    } catch (e) {}
    removeEl(pipe, el);
    pipe.elA = null;
  }
  function attachB(pipe) {
    if (pipe.elB) return;
    var el = makeHiddenVideo();
    pipe.els.push(el);
    pipe.elB = el;
    el.srcObject = pipe.sB;
    pipe.trackB = pipe.sB.getVideoTracks()[0];
    playQuiet(el, '受信B');
    countFrames(el, 'B', pipe);
  }
  function detachB(pipe) {
    var el = pipe.elB;
    pipe.trackB = null;
    if (!el) return;
    el.__off = true;
    try {
      el.srcObject = null;
    } catch (e) {}
    removeEl(pipe, el);
    pipe.elB = null;
  }
  function startLoopback(pipe, stream) {
    if (pipe.pc1) return;
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
        pipe.elLoop = el;
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
  function stopLoopback(pipe) {
    var el = pipe.elLoop;
    if (el) {
      el.__off = true;
      try {
        el.srcObject = null;
      } catch (e) {}
      removeEl(pipe, el);
      pipe.elLoop = null;
    }
    try {
      if (pipe.pc1) pipe.pc1.close();
      if (pipe.pc2) pipe.pc2.close();
    } catch (e) {}
    pipe.pc1 = null;
    pipe.pc2 = null;
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

  // ====== 試験の進行（局面＝枚数の原因切り分け、区間＝動きの指示） ======
  function applyPhase(pipe, k) {
    if (k === 0 || k === 4) {
      attachA(pipe);
      attachB(pipe);
      startLoopback(pipe, pipe.sA);
    } else if (k === 1) {
      stopLoopback(pipe);
    } else if (k === 2) {
      detachB(pipe);
    } else if (k === 3) {
      detachA(pipe);
    }
  }
  function endPhase() {
    var p = curPhase;
    if (!p) return;
    var s = p.secs || 1;
    log(
      '【局面' + (curPhaseIdx + 1) + ' ' + PHASES[curPhaseIdx].name + '】' + p.secs + '秒 出力' + r1(p.out / s) + 'fps 検出' +
        r1(p.det / s) + 'ms 処理' + r1(p.proc / s) + 'ms｜受信A' + r1(p.A / s) + ' B' + r1(p.B / s) + ' 送受' + r1(p.loop / s)
    );
    curPhase = null;
  }
  function runPhase(pipe, k) {
    if (pipe.stopped) return;
    endPhase();
    if (k >= PHASES.length) {
      detachA(pipe);
      detachB(pipe);
      stopLoopback(pipe);
      log('枚数の切り分け完了。以降は検出と描画のみ（実際の配信に近い構成）');
      return;
    }
    curPhaseIdx = k;
    curPhase = newAcc();
    applyPhase(pipe, k);
    log('局面' + (k + 1) + '/' + PHASES.length + ' 開始：' + PHASES[k].name);
    pipe.timers.push(
      setTimeout(function () {
        runPhase(pipe, k + 1);
      }, PHASE_SEC * 1000 * TS)
    );
  }
  function endSegment(i) {
    var a = curSeg;
    if (!a) return;
    var tot = a.frames + a.standby;
    var s = a.secs || 1;
    log(
      '【区間' + (i + 1) + ' ' + SEGS[i].short + '】' + a.secs + '秒 出力' + r1(a.out / s) + 'fps 処理' + r1(a.proc / s) +
        'ms 見失い' + a.lost + ' 待機' + (tot ? r0((100 * a.standby) / tot) : 0) + '%｜最大の向き(行列) 左右+' + r0(a.mP) +
        '/-' + r0(a.mN) + ' 上下+' + r0(a.pP) + '/-' + r0(a.pN) + '｜(幾何) 左右+' + r0(a.gP) + '/-' + r0(a.gN)
    );
    curSeg = null;
  }
  function runSegment(pipe, i) {
    if (pipe.stopped) return;
    if (i > 0) endSegment(i - 1);
    if (i === 5 || i === 8) logBins('区間' + i + 'まで');
    if (i >= SEGS.length) {
      promptText = '【終了】「ログをコピー」を押し、チャットに貼る。その後Userscriptsを全部オフ';
      promptEnd = 0;
      logBins('最終');
      log('試験の進行は終了');
      return;
    }
    curSegIdx = i;
    curSeg = newAcc();
    promptText = '【指示' + (i + 1) + '/' + SEGS.length + '】' + SEGS[i].text;
    promptEnd = performance.now() + SEGS[i].sec * 1000 * TS;
    log('区間' + (i + 1) + '/' + SEGS.length + ' 開始：' + SEGS[i].text);
    if (i === 0) runPhase(pipe, 0);
    pipe.timers.push(
      setTimeout(function () {
        runSegment(pipe, i + 1);
      }, SEGS[i].sec * 1000 * TS)
    );
  }
  function startSession(pipe) {
    if (pipe.sess || pipe.stopped) return;
    pipe.sess = true;
    log('試験の進行を開始。これ以降、画面の指示どおりに動く');
    runSegment(pipe, 0);
  }

  // ====== 数字の更新（1秒ごと） ======
  function logSummary(pipe, sec) {
    log(
      '【経過' + sec + '秒】出力' + S.out + ' 検出' + S.det + ' 検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ') 処理' +
        r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ') 測定' + r1(S.metAvg) + 'ms 見失い' + lostCount + ' 待機' +
        S.standbyPct + '% 受信A' + S.A + ' B' + S.B + ' 送受' + S.loop
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
    var m = avgMax(metSamples);
    S.detAvg = d[0];
    S.procAvg = p[0];
    S.metAvg = m[0];
    detSamples = [];
    procSamples = [];
    metSamples = [];
    var tot = winFace + winStandby;
    S.standbyPct = tot ? Math.round((100 * winStandby) / tot) : 0;
    winFace = 0;
    winStandby = 0;
    [curSeg, curPhase].forEach(function (a) {
      if (!a) return;
      a.secs++;
      a.out += S.out;
      a.proc += S.procAvg;
      a.det += S.detAvg;
      a.A += S.A;
      a.B += S.B;
      a.loop += S.loop;
    });
    updateHead();
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

  // ====== パイプライン（本物のカメラ→顔認識→覆い→出力）の開始と停止 ======
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

        // 出力方法の比較：A=自動30枚 / B=描くたびに手動で送る。開始時は全部オン（V5と同じ）
        pipe.sA = canvas.captureStream(30);
        pipe.sB = canvas.captureStream(0);
        attachA(pipe);
        attachB(pipe);
        startLoopback(pipe, pipe.sA);

        startLoop(pipe);
        pipe.timers.push(setInterval(tickStats, 1000));
        [20, 60, 120, 300, 600, 900, 1200].forEach(function (sec) {
          pipe.timers.push(
            setTimeout(function () {
              if (!pipe.stopped) logSummary(pipe, sec);
            }, sec * 1000 * TS)
          );
        });
        loadMediaPipe().then(
          function () {
            startSession(pipe);
          },
          function () {
            log('顔認識が使えないため、試験の進行は始めない');
          }
        );
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
    pipe.els.slice().forEach(function (el) {
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
        wrapTrack(vt, 'V6出力');
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
