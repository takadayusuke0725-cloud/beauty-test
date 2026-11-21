// ==UserScript==
// @name         FakeCamWarpV8b
// @description  【実験V8b】V8の見直し版。整形(パーツ変形)と美肌をWebGLで試す。顔認識の部品がStripchat側の制限(CSP)で止められた時の別の読み込み方法と、制限の内容のログ、起動の停止対策つき。顔は隠さない。配信開始は押さないこと。
// @match        https://stripchat.com/*
// @match        https://*.stripchat.com/*
// @match        https://takadayusuke0725-cloud.github.io/*
// @run-at       document-start
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';
  if (window.__fakeCamInstalledV8b) return;
  window.__fakeCamInstalledV8b = true;

  // ====== 調整値 ======
  var EDGE_MARGIN = 0.01; // 顔の輪郭が画面の端からこの比率以内なら待機画面
  var PHASE_SEC = 20; // 自動試験の1局面の秒数
  var TS = typeof window.__v8TimeScale === 'number' && window.__v8TimeScale > 0 ? window.__v8TimeScale : 1; // 擬似環境の試験用。通常は1
  var GX = 96; // 変形用の格子の分割数（横）
  var GY = 72; // 同（縦）
  var MAXC = 128; // 変形の制御点の最大数（シェーダーの配列の大きさ）
  var OUT_VIA_2D = true; // true＝WebGLの結果を2Dのキャンバスに写して出力する（V7で動作確認済みの出力方式）／false＝WebGLのキャンバスを直接出力する

  // ====== 部品の場所（Google公式の案内どおり） ======
  var MP_MODULE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/vision_bundle.mjs';
  var MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
  var MP_MODEL =
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

  // ====== 顔の点の番号（MediaPipeの標準。記憶ベースで未確認。画面で目視確認する） ======
  var FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176,
    149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
  ];
  var EYE_R = [33, 160, 159, 158, 133, 153, 145, 144]; // 向かって左の目（本人の右目）。33=目尻、133=目頭
  var EYE_L = [263, 387, 386, 385, 362, 380, 374, 373]; // 向かって右の目。263=目尻、362=目頭
  var BROW_R = [70, 105, 107, 46, 52];
  var BROW_L = [300, 334, 336, 276, 282];
  var NOSE_IDS = [1, 4, 2, 129, 358, 98, 327, 168, 6];
  var MOUTH_OUT = [61, 291, 0, 17, 37, 267, 84, 314];
  var MOUTH_IN = [13, 14, 78, 308];
  var EXTRA_ANCHORS = [50, 280, 205, 425, 116, 345, 123, 352, 9, 151];
  // 美肌のマスクで除外する範囲（点の集合の凸包で作る＝並び順は不問）
  var MASK_EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
  var MASK_EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
  var MASK_BROW_R = [46, 53, 52, 65, 55, 70, 63, 105, 66, 107];
  var MASK_BROW_L = [276, 283, 282, 295, 285, 300, 293, 334, 296, 336];
  var MASK_LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 185, 40, 39, 37, 0, 267, 269, 270, 409, 78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 191, 80, 81, 82, 13, 312, 311, 310, 415];
  var MASK_NOSE_BOTTOM = [98, 327, 129, 358, 2, 94, 19, 4];

  // ====== パラメータ（画面のスライダーと同じ。0＝変形なし） ======
  var PARAM_DEFS = [
    { k: 'eyeSize', label: '目の大きさ（大＋）', min: -1, max: 1 },
    { k: 'eyeSlim', label: '目の細さ・縦（細＋）', min: -1, max: 1 },
    { k: 'eyeTilt', label: 'つり目＋／たれ目－', min: -1, max: 1 },
    { k: 'eyeDist', label: '目の間隔（離す＋）', min: -1, max: 1 },
    { k: 'browLift', label: '眉の高さ（上＋）', min: -1, max: 1 },
    { k: 'noseSlim', label: '鼻を細く（細＋）', min: -1, max: 1 },
    { k: 'noseLen', label: '鼻を長く（長＋）', min: -1, max: 1 },
    { k: 'noseHigh', label: '鼻を高く（陰影・高＋）', min: 0, max: 1 },
    { k: 'mouthW', label: '口の幅（広＋）', min: -1, max: 1 },
    { k: 'mouthThick', label: '唇の厚み（厚＋）', min: -1, max: 1 },
    { k: 'mouthCorner', label: '口角（上げ＋）', min: -1, max: 1 },
    { k: 'jawSlim', label: '顎を細く（細＋）', min: -1, max: 1 },
    { k: 'smooth', label: '肌をなめらか', min: 0, max: 1 },
    { k: 'wrinkle', label: 'シワ除去', min: 0, max: 1 },
    { k: 'spot', label: 'シミ・ほくろ除去', min: 0, max: 1 }
  ];
  var params = {};
  PARAM_DEFS.forEach(function (d) {
    params[d.k] = 0;
  });
  var sliderEls = {};

  var PRESETS = [
    { name: '変形なし・美肌なし(基準)', p: {} },
    { name: '整形A(中)：目大きく・つり目、鼻細く長く', p: { eyeSize: 0.4, eyeTilt: 0.3, noseSlim: 0.4, noseLen: 0.3, noseHigh: 0.4, mouthW: -0.1 } },
    { name: '整形B(中)：目細く・たれ目、鼻細く、口角上げ', p: { eyeSlim: 0.4, eyeTilt: -0.4, noseSlim: 0.4, mouthCorner: 0.3, browLift: 0.2 } },
    { name: '整形(強め・限界の確認)', p: { eyeSize: 0.9, eyeTilt: 0.8, noseSlim: 0.9, noseLen: 0.8, mouthW: -0.6, mouthThick: 0.6, jawSlim: 0.8, eyeDist: 0.6 } },
    { name: '美肌のみ(強)', p: { smooth: 0.8, wrinkle: 0.8, spot: 0.9 } },
    { name: '整形A＋美肌(中)', p: { eyeSize: 0.4, eyeTilt: 0.3, noseSlim: 0.4, noseLen: 0.3, mouthW: -0.1, smooth: 0.5, wrinkle: 0.5, spot: 0.7 } },
    { name: '変形なし・美肌なし(再確認)', p: {} }
  ];
  var curPresetName = '手動';

  var t0 = Date.now();
  var logs = [];
  var MAX = 600;
  var isOpen = false;
  var showSliders = false;
  var calls = 0;
  var panel = null;
  var head = null;
  var body = null;
  var sliderBox = null;
  var seen = {};
  var promptText = '';
  var promptEnd = 0;
  var maskDebug = false;
  var ratingN = { good: 0, so: 0, bad: 0 };
  var copyErrCount = 0;

  // ---- 測定の数字 ----
  var C = { out: 0, det: 0 };
  var S = { out: 0, det: 0, detAvg: 0, procAvg: 0, drawAvg: 0, standbyPct: 0, lagCam: -1 };
  var detSamples = [];
  var procSamples = [];
  var drawSamples = [];
  var runDetMax = 0;
  var runProcMax = 0;
  var lostCount = 0;
  var wasFace = false;
  var winFace = 0;
  var winStandby = 0;
  var reasonCount = {};
  var lastTs = 0;
  var detErrCount = 0;
  var drawErrCount = 0;
  var lagSum = 0;
  var lagN = 0;
  var lagMax = 0;

  // ---- 向き（度）----
  var yawM = null;
  var pitchM = null;
  var layoutLogged = false;
  var lastAng = null;
  var lostInfo = null;
  var stopsN = 0;
  var maxYaw = [0, 0];

  // ---- 局面の集計 ----
  function newAcc() {
    return { secs: 0, out: 0, proc: 0, det: 0, draw: 0, frames: 0, standby: 0, lost: 0, lagSum: 0, lagN: 0, lagMax: 0 };
  }
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
  function paramsText() {
    var parts = [];
    PARAM_DEFS.forEach(function (d) {
      if (Math.abs(params[d.k]) > 0.001) parts.push(d.k + '=' + r2(params[d.k]));
    });
    return parts.length ? parts.join(' ') : '(すべて0)';
  }
  function updateHead() {
    if (!head) return;
    var pr = '';
    if (promptText) {
      var left = promptEnd ? Math.max(0, Math.round((promptEnd - performance.now()) / 1000)) : 0;
      pr = promptText + (promptEnd ? ' 残' + left + '秒' : '') + '\n';
    }
    head.textContent =
      pr +
      'V8b（要求' + calls + '回）' + (isOpen ? ' ▼' : ' ▲タップで開く') + '\n' +
      '出力' + S.out + 'fps／検出' + S.det + 'fps／検出' + r1(S.detAvg) + 'ms／処理' + r1(S.procAvg) + 'ms(最大' + r0(runProcMax) +
      ')／描画' + r1(S.drawAvg) + 'ms\n' +
      '見失い' + lostCount + '回／待機' + S.standbyPct + '%' + (S.lagCam >= 0 ? '／カメラ遅れ' + r0(S.lagCam) + 'ms' : '') + '／向き 左右' +
      fa(yawM) + '° 上下' + fa(pitchM) + '°';
  }
  function render() {
    if (!panel) return;
    updateHead();
    body.style.display = isOpen ? 'block' : 'none';
    sliderBox.style.display = showSliders ? 'block' : 'none';
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
  function fallbackCopy(text, okMsg) {
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
      log(ok ? okMsg + '（代替方式）' : 'コピー失敗：ログ表示を開いて長押しで選ぶ');
    } catch (e) {
      log('コピー失敗 ' + errText(e));
    }
  }
  function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () {
            log(okMsg);
          },
          function () {
            fallbackCopy(text, okMsg);
          }
        );
        return;
      }
    } catch (e) {}
    fallbackCopy(text, okMsg);
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
  function setParam(k, v) {
    params[k] = v;
    var el = sliderEls[k];
    if (el) {
      el.input.value = String(v);
      el.val.textContent = r2(v);
    }
  }
  function applyPreset(i) {
    var pr = PRESETS[i];
    PARAM_DEFS.forEach(function (d) {
      setParam(d.k, pr.p[d.k] !== undefined ? pr.p[d.k] : 0);
    });
    curPresetName = pr.name;
  }
  function rate(kind, label) {
    ratingN[kind]++;
    log('【評価:' + label + '】 ' + curPresetName + ' | ' + paramsText() + ' | 向き左右' + fa(yawM) + '° 上下' + fa(pitchM) + '°');
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
        makeBtn('自然', function () {
          rate('good', '自然');
        })
      );
      row.appendChild(
        makeBtn('少し不自然', function () {
          rate('so', '少し不自然');
        })
      );
      row.appendChild(
        makeBtn('不自然', function () {
          rate('bad', '不自然');
        })
      );
      row.appendChild(
        makeBtn('調整', function () {
          showSliders = !showSliders;
          render();
        })
      );
      row.appendChild(
        makeBtn('マスク表示', function (b) {
          maskDebug = !maskDebug;
          b.textContent = maskDebug ? 'マスク表示中' : 'マスク表示';
          log('肌マスクの表示：' + (maskDebug ? 'オン（赤＝美肌をかけない範囲）' : 'オフ'));
        })
      );
      row.appendChild(
        makeBtn('設定をコピー', function () {
          copyText('V8設定 ' + curPresetName + ' ' + safeJson(params), '設定をコピーした');
        })
      );
      row.appendChild(
        makeBtn('ログをコピー', function () {
          copyText(logs.join('\n'), 'ログをコピーした（' + logs.length + '行）');
        })
      );
      sliderBox = document.createElement('div');
      sliderBox.style.cssText = 'display:none;max-height:34vh;overflow:auto;margin:4px 0;';
      PARAM_DEFS.forEach(function (d) {
        var line = document.createElement('div');
        line.style.cssText = 'display:flex;align-items:center;margin:1px 0;';
        var lab = document.createElement('span');
        lab.textContent = d.label;
        lab.style.cssText = 'width:9.5em;font-size:10px;flex:none;';
        var inp = document.createElement('input');
        inp.type = 'range';
        inp.min = String(d.min);
        inp.max = String(d.max);
        inp.step = '0.05';
        inp.value = String(params[d.k]);
        inp.style.cssText = 'flex:1;min-width:120px;';
        var val = document.createElement('span');
        val.textContent = r2(params[d.k]);
        val.style.cssText = 'width:3em;text-align:right;font-size:10px;flex:none;';
        inp.addEventListener('input', function () {
          params[d.k] = parseFloat(inp.value);
          val.textContent = r2(params[d.k]);
          curPresetName = '手動';
        });
        sliderEls[d.k] = { input: inp, val: val };
        line.appendChild(lab);
        line.appendChild(inp);
        line.appendChild(val);
        sliderBox.appendChild(line);
      });
      body = document.createElement('pre');
      body.style.cssText =
        'display:none;margin:4px 0;max-height:42vh;max-width:92vw;overflow:auto;' +
        'white-space:pre-wrap;word-break:break-all;font:10px/1.3 monospace;color:#0f0;';
      panel.appendChild(head);
      panel.appendChild(row);
      panel.appendChild(sliderBox);
      panel.appendChild(body);
    }
    if (!panel.isConnected) document.body.appendChild(panel);
    render();
  }
  setInterval(ensurePanel, 500);
  document.addEventListener('DOMContentLoaded', ensurePanel);

  log('V8b起動 ' + location.hostname + '／' + (window.top !== window ? 'iframe内' : '最上位'));

  // ====== エラーとページの制限の記録 ======
  window.addEventListener('error', function (e) {
    log('エラー: ' + (e && e.message));
  });
  window.addEventListener('unhandledrejection', function (e) {
    log('未処理の拒否: ' + errText(e && e.reason));
  });
  var cspLogged = false;
  function logCsp(tag, text) {
    if (!text) return;
    String(text)
      .split(';')
      .forEach(function (d) {
        d = d.trim();
        if (!/^(default-src|script-src|script-src-elem|connect-src|worker-src|child-src|media-src)( |$)/.test(d)) return;
        for (var i = 0; i < d.length && i < 1320; i += 220) log('CSP[' + tag + '] ' + d.slice(i, i + 220));
      });
  }
  document.addEventListener('securitypolicyviolation', function (e) {
    log('制限に引っかかった: ' + e.violatedDirective + ' ' + short(e.blockedURI, 90));
    if (!cspLogged) {
      cspLogged = true;
      logCsp('違反時', e.originalPolicy);
    }
  });
  function cspProbe() {
    try {
      var ms = document.querySelectorAll('meta[http-equiv]');
      for (var i = 0; i < ms.length; i++) {
        if (/content-security-policy/i.test(ms[i].getAttribute('http-equiv') || '')) logCsp('meta', ms[i].getAttribute('content'));
      }
    } catch (e) {}
    try {
      fetch(location.href, { credentials: 'same-origin' }).then(
        function (r) {
          var c = r.headers.get('content-security-policy');
          var ro = r.headers.get('content-security-policy-report-only');
          if (!c && !ro) log('CSP(ヘッダー): なし');
          logCsp('ヘッダー', c);
          logCsp('ヘッダー報告のみ', ro);
        },
        function (e) {
          log('CSPの確認に失敗 ' + errText(e));
        }
      );
    } catch (e) {}
  }
  setTimeout(cspProbe, 1500);
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
        if (/camera|media|permission|denied|NotAllowed|stream|device|webgl|shader/i.test(m)) {
          log('console.' + k + ': ' + m);
        }
      } catch (e) {}
      return orig.apply(console, arguments);
    };
  });

  // ====== 顔認識の部品の読み込み（Stripchat側の制限(CSP)で止められた時の、別の方法つき） ======
  function importModule(url) {
    if (window.__mpTestStub) return Promise.resolve(window.__mpTestStub);
    return import(url).then(
      function (m) {
        log('部品(JS) 通常の読み込みで成功');
        return m;
      },
      function (e1) {
        log('部品(JS) 通常の読み込みに失敗(' + short(errText(e1), 70) + ')→取得してから読み込む方法を試す');
        return fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('取得失敗 ' + r.status);
            return r.text();
          })
          .then(function (t) {
            return import(URL.createObjectURL(new Blob([t], { type: 'text/javascript' })));
          })
          .then(function (m) {
            log('部品(JS) 取得方式で成功');
            return m;
          });
      }
    );
  }
  function tryCreate(mod, fileset, delegate, modelBuf) {
    var base = modelBuf ? { modelAssetBuffer: modelBuf, delegate: delegate } : { modelAssetPath: MP_MODEL, delegate: delegate };
    return mod.FaceLandmarker.createFromOptions(fileset, {
      baseOptions: base,
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true // 向き（度）を出すため
    }).then(function (lm) {
      log('顔認識を作成 delegate=' + delegate + (modelBuf ? '（取得方式）' : ''));
      return lm;
    });
  }
  function createBoth(mod, fileset, modelBuf) {
    return tryCreate(mod, fileset, 'GPU', modelBuf).catch(function (e) {
      log('GPUで失敗(' + short(errText(e), 60) + ')→CPUで再試行');
      return tryCreate(mod, fileset, 'CPU', modelBuf);
    });
  }
  // wasmの部品を、取得してからblobの形で渡す（外部の読み込みを止められた時の方法）
  function blobFileset(fs) {
    var out = {};
    for (var k in fs) out[k] = fs[k];
    var p1 = fetch(fs.wasmLoaderPath)
      .then(function (r) {
        if (!r.ok) throw new Error('取得失敗(loader) ' + r.status);
        return r.text();
      })
      .then(function (t) {
        return URL.createObjectURL(new Blob([t], { type: 'text/javascript' }));
      });
    var p2 = fetch(fs.wasmBinaryPath)
      .then(function (r) {
        if (!r.ok) throw new Error('取得失敗(wasm) ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (b) {
        return URL.createObjectURL(new Blob([b], { type: 'application/wasm' }));
      });
    return Promise.all([p1, p2]).then(function (a) {
      out.wasmLoaderPath = a[0];
      out.wasmBinaryPath = a[1];
      return out;
    });
  }
  function loadMediaPipe() {
    if (mpPromise) return mpPromise;
    var tl = performance.now();
    mpPromise = importModule(MP_MODULE)
      .then(function (mod) {
        log('部品(JS)の準備 ' + r0(performance.now() - tl) + 'ms');
        return mod.FilesetResolver.forVisionTasks(MP_WASM).then(function (fileset) {
          log('wasmの準備OK ' + r0(performance.now() - tl) + 'ms');
          return createBoth(mod, fileset, null).catch(function (eA) {
            log('通常の方法で顔認識を作れない(' + short(errText(eA), 90) + ')→取得方式を試す');
            return blobFileset(fileset).then(function (fs2) {
              return fetch(MP_MODEL)
                .then(function (r) {
                  if (!r.ok) throw new Error('取得失敗(model) ' + r.status);
                  return r.arrayBuffer();
                })
                .then(function (b) {
                  return createBoth(mod, fs2, new Uint8Array(b));
                });
            });
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
          log('顔認識の準備に失敗: ' + short(errText(e), 160));
          throw e;
        }
      );
    mpPromise.catch(function () {});
    return mpPromise;
  }
  // 最初の検出は重いので、WebGLを準備する前に1回済ませる（起動の停止対策）
  function warmUp(pipe) {
    try {
      var t = performance.now();
      var stamp = Math.max(lastTs + 1, Math.round(performance.now()));
      lastTs = stamp;
      landmarker.detectForVideo(pipe.video, stamp);
      log('試し検出 ' + r0(performance.now() - t) + 'ms');
    } catch (e) {
      log('試し検出で例外 ' + short(errText(e), 100));
    }
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
  // 顔の変換行列から向き（度）を出す。符号の向きは、V6で「左を向く＝＋、右＝−」と確認済み
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
  function updatePose(res) {
    var m = matInfo(res);
    if (m) {
      yawM = m.yaw;
      pitchM = m.pitch;
      if (!layoutLogged) {
        layoutLogged = true;
        log('向きの行列：' + (m.colMajor ? '列ごとの並び' : '行ごとの並び') + 'と判定');
      }
      if (m.yaw > maxYaw[0]) maxYaw[0] = m.yaw;
      if (-m.yaw > maxYaw[1]) maxYaw[1] = -m.yaw;
    } else {
      yawM = null;
      pitchM = null;
    }
  }
  // 顔の位置が危ないとき、理由を返す（問題なければnull）。「画面の端」だけが条件
  function checkPose(pts) {
    for (var i = 0; i < FACE_OVAL.length; i++) {
      var p = pts[FACE_OVAL[i]];
      if (p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN || p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN) return '画面の端';
    }
    return null;
  }

  // ====== 変形の制御点（点の動かし方）。座標は「画面の高さ＝1」の単位（横は 幅/高さ 倍） ======
  var CP = new Float32Array(MAXC * 4); // x, y, dx, dy
  var CR = new Float32Array(MAXC); // 影響の広がり（半径）
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function buildControls(pts, w, h) {
    var A = w / h;
    var n = 0;
    function X(i) {
      return pts[i].x * A;
    }
    function Y(i) {
      return pts[i].y;
    }
    function add(i, dx, dy, r) {
      if (n >= MAXC) return;
      CP[n * 4] = X(i);
      CP[n * 4 + 1] = Y(i);
      CP[n * 4 + 2] = dx;
      CP[n * 4 + 3] = dy;
      CR[n] = r;
      n++;
    }
    var fw = Math.abs(X(454) - X(234)) || 0.3; // 顔の幅
    var fh = Math.abs(Y(152) - Y(10)) || 0.4; // 顔の高さ
    var P = params;
    var i;
    var k;

    // --- 目 ---
    var eyes = [
      { ids: EYE_R, inner: 133, outer: 33, side: -1 },
      { ids: EYE_L, inner: 362, outer: 263, side: 1 }
    ];
    var sx = 1 + 0.25 * P.eyeSize;
    var sy = Math.max(0.2, (1 + 0.3 * P.eyeSize) * (1 - 0.35 * P.eyeSlim));
    for (k = 0; k < eyes.length; k++) {
      var e = eyes[k];
      var cx = 0;
      var cy = 0;
      for (i = 0; i < e.ids.length; i++) {
        cx += X(e.ids[i]);
        cy += Y(e.ids[i]);
      }
      cx /= e.ids.length;
      cy /= e.ids.length;
      var ax = X(e.outer) - X(e.inner);
      var ay = Y(e.outer) - Y(e.inner);
      var al = ax * ax + ay * ay || 1e-6;
      for (i = 0; i < e.ids.length; i++) {
        var id = e.ids[i];
        var px = X(id);
        var py = Y(id);
        var nx = cx + (px - cx) * sx;
        var ny = cy + (py - cy) * sy;
        var t = clamp(((px - X(e.inner)) * ax + (py - Y(e.inner)) * ay) / al, 0, 1);
        ny += -P.eyeTilt * 0.06 * fw * t; // つり目＋＝目尻が上がる（画面の上は y が小さい方）
        nx += e.side * P.eyeDist * 0.05 * fw;
        add(id, nx - px, ny - py, 0.09 * fw);
      }
    }
    // --- 眉 ---
    var browIds = BROW_R.concat(BROW_L);
    for (i = 0; i < browIds.length; i++) add(browIds[i], 0, -P.browLift * 0.06 * fh, 0.1 * fw);
    // --- 鼻 ---
    var ncx = X(1);
    for (i = 0; i < NOSE_IDS.length; i++) {
      var nid = NOSE_IDS[i];
      var ndx = 0;
      var ndy = 0;
      if (nid === 129 || nid === 358 || nid === 98 || nid === 327) {
        ndx = -(X(nid) - ncx) * 0.3 * P.noseSlim;
        ndy = P.noseLen * 0.035 * fh;
      } else if (nid === 1 || nid === 4 || nid === 2) {
        ndy = P.noseLen * 0.05 * fh;
      }
      add(nid, ndx, ndy, 0.09 * fw);
    }
    // --- 口 ---
    var mcx = (X(61) + X(291)) / 2;
    var mcy = (Y(13) + Y(14)) / 2;
    var msx = 1 + 0.25 * P.mouthW;
    var msy = 1 + 0.35 * P.mouthThick;
    var mw = Math.abs(X(291) - X(61)) || 0.1;
    var mouthIds = MOUTH_OUT.concat(MOUTH_IN);
    for (i = 0; i < mouthIds.length; i++) {
      var mid = mouthIds[i];
      var mx = X(mid);
      var my = Y(mid);
      var mnx = mcx + (mx - mcx) * msx;
      var mny = mcy + (my - mcy) * msy;
      var wc = clamp(Math.abs(mx - mcx) / (0.5 * mw), 0, 1);
      mny += -P.mouthCorner * 0.035 * fh * wc * wc;
      add(mid, mnx - mx, mny - my, 0.1 * fw);
    }
    // --- 輪郭（顎）と、動かさない点 ---
    var fcx = (X(234) + X(454)) / 2;
    var ty = Y(1);
    var by = Y(152);
    for (i = 0; i < FACE_OVAL.length; i++) {
      var oid = FACE_OVAL[i];
      var f = clamp((Y(oid) - ty) / (by - ty || 1e-6), 0, 1);
      add(oid, -(X(oid) - fcx) * 0.12 * P.jawSlim * f, 0, 0.14 * fw);
    }
    for (i = 0; i < EXTRA_ANCHORS.length; i++) add(EXTRA_ANCHORS[i], 0, 0, 0.14 * fw);
    return n;
  }

  // ====== WebGL（映像を格子に貼り、制御点で変形し、美肌をかける） ======
  var VS_MAIN =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'layout(location=0) in vec2 aPos;\n' +
    'uniform float uAspect;\n' +
    'uniform int uN;\n' +
    'uniform vec4 uC[' + MAXC + '];\n' +
    'uniform float uR[' + MAXC + '];\n' +
    'out vec2 vTex;\n' +
    'void main(){\n' +
    '  vec2 p = vec2(aPos.x*uAspect, aPos.y);\n' +
    '  vec2 sd = vec2(0.0); float sw = 0.0;\n' +
    '  for(int i=0;i<' + MAXC + ';i++){\n' +
    '    if(i>=uN) break;\n' +
    '    vec2 d = p - uC[i].xy; float r = uR[i];\n' +
    '    float w = exp(-dot(d,d)/(r*r));\n' +
    '    sd += w*uC[i].zw; sw += w;\n' +
    '  }\n' +
    '  vec2 disp = sd/(sw+0.03);\n' +
    '  vec2 q = aPos + vec2(disp.x/uAspect, disp.y);\n' +
    '  gl_Position = vec4(q.x*2.0-1.0, 1.0-q.y*2.0, 0.0, 1.0);\n' +
    '  vTex = aPos;\n' +
    '}\n';
  var FS_MAIN =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'in vec2 vTex;\n' +
    'uniform sampler2D uTex;\n' +
    'uniform sampler2D uMask;\n' +
    'uniform vec2 uTexel;\n' +
    'uniform float uRad;\n' +
    'uniform float uSmooth;\n' +
    'uniform float uWrinkle;\n' +
    'uniform float uSpot;\n' +
    'uniform float uDebug;\n' +
    'uniform float uNoseK;\n' +
    'uniform vec2 uNoseA;\n' +
    'uniform vec2 uNoseB;\n' +
    'uniform float uFw;\n' +
    'uniform float uAspect;\n' +
    'out vec4 o;\n' +
    'const vec2 K[16] = vec2[16](vec2(-0.94,-0.40),vec2(-0.09,-0.93),vec2(0.34,0.29),vec2(0.82,-0.26),' +
    'vec2(-0.38,0.28),vec2(0.17,-0.45),vec2(-0.82,0.11),vec2(0.54,0.82),vec2(-0.58,0.77),vec2(0.96,0.20),' +
    'vec2(-0.12,0.95),vec2(0.46,-0.89),vec2(-0.34,-0.62),vec2(0.74,0.51),vec2(-0.99,-0.01),vec2(0.05,0.12));\n' +
    'void main(){\n' +
    '  vec3 c = texture(uTex, vTex).rgb;\n' +
    '  float m = 0.0;\n' +
    '  vec3 res = c;\n' +
    '  if (uSmooth + uWrinkle + uSpot + uDebug > 0.001) {\n' +
    '    m = texture(uMask, vTex).r;\n' +
    '    if (m > 0.02 && (uSmooth + uWrinkle + uSpot) > 0.001) {\n' +
    '      float lc = dot(c, vec3(0.299,0.587,0.114));\n' +
    '      vec3 s1 = c; float w1 = 1.0; vec3 s2 = c; float w2 = 1.0; vec3 mean = c; float cnt = 1.0;\n' +
    '      for (int i=0;i<16;i++){\n' +
    '        vec3 a = texture(uTex, vTex + K[i]*uRad*uTexel).rgb;\n' +
    '        float d1 = length(a-c); float wa = exp(-d1*d1*40.0); s1 += a*wa; w1 += wa;\n' +
    '        vec3 b = texture(uTex, vTex + K[i]*uRad*2.5*uTexel).rgb;\n' +
    '        float d2 = length(b-c); float wb = exp(-d2*d2*18.0); s2 += b*wb; w2 += wb;\n' +
    '        mean += b; cnt += 1.0;\n' +
    '      }\n' +
    '      vec3 sm1 = s1/w1; vec3 sm2 = s2/w2; mean /= cnt;\n' +
    '      vec3 r = mix(c, sm1, uSmooth*m);\n' +
    '      r = mix(r, sm2, uWrinkle*m);\n' +
    '      float lmRaw = dot(mean, vec3(0.299,0.587,0.114));\n' +
    '      vec3 mb = vec3(0.0); float cb = 0.0;\n' +
    '      for (int j=0;j<16;j++){\n' +
    '        vec3 bb = texture(uTex, vTex + K[j]*uRad*3.0*uTexel).rgb;\n' +
    '        if (dot(bb, vec3(0.299,0.587,0.114)) > lmRaw - 0.04) { mb += bb; cb += 1.0; }\n' +
    '      }\n' +
    '      vec3 meanB = cb > 0.5 ? mb/cb : mean;\n' +
    '      float lm = dot(meanB, vec3(0.299,0.587,0.114));\n' +
    '      float dark = clamp((lm - lc - 0.03)/0.06, 0.0, 1.0);\n' +
    '      r = mix(r, meanB, dark*uSpot*m);\n' +
    '      res = r;\n' +
    '    }\n' +
    '    if (uDebug > 0.5) res = mix(res, vec3(1.0,0.0,0.0), 0.55*(1.0-m));\n' +
    '  }\n' +
    '  if (uNoseK > 0.001) {\n' +
    '    vec2 p2 = vec2(vTex.x*uAspect, vTex.y);\n' +
    '    vec2 ab = uNoseB - uNoseA; float L = max(length(ab), 0.0001);\n' +
    '    vec2 nu = ab / L; vec2 rel = p2 - uNoseA;\n' +
    '    float t = dot(rel, nu) / L;\n' +
    '    float lat = abs(dot(rel, vec2(-nu.y, nu.x))) / max(uFw, 0.0001);\n' +
    '    float tt = smoothstep(0.05, 0.3, t) * (1.0 - smoothstep(0.85, 1.1, t));\n' +
    '    float hi = exp(-(lat*lat)/0.0018) * tt;\n' +
    '    float sh = exp(-((lat-0.13)*(lat-0.13))/0.0018) * tt;\n' +
    '    res = res + uNoseK * 0.14 * hi * (vec3(1.0) - res);\n' +
    '    res = res * (1.0 - uNoseK * 0.09 * sh);\n' +
    '  }\n' +
    '  o = vec4(res, 1.0);\n' +
    '}\n';
  var VS_BLIT =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'out vec2 vUV;\n' +
    'void main(){\n' +
    '  vec2 p = vec2(float((gl_VertexID<<1)&2), float(gl_VertexID&2));\n' +
    '  vUV = vec2(p.x, 1.0-p.y);\n' +
    '  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);\n' +
    '}\n';
  var FS_BLIT =
    '#version 300 es\n' +
    'precision highp float;\n' +
    'in vec2 vUV;\n' +
    'uniform sampler2D uTex;\n' +
    'out vec4 o;\n' +
    'void main(){ o = vec4(texture(uTex, vUV).rgb, 1.0); }\n';

  function compileShader(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダー失敗 ' + short(gl.getShaderInfoLog(s), 160));
    return s;
  }
  function linkProgram(gl, vsSrc, fsSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('リンク失敗 ' + short(gl.getProgramInfoLog(p), 160));
    return p;
  }
  function makeTex(gl) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  // 出力用のキャンバスを作る。WebGLは、顔認識の準備が済んでから作る（deferGL）。失敗したら2Dのキャンバス（待機画面だけ）にする
  function initOutput(pipe, deferGL) {
    var cv = document.createElement('canvas');
    cv.width = pipe.w;
    cv.height = pipe.h;
    cv.style.cssText = 'position:fixed;right:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    (document.body || document.documentElement).appendChild(cv);
    pipe.canvas = cv;
    pipe.out2d = null;
    pipe.glCanvas = null;
    if (OUT_VIA_2D) {
      var oc = document.createElement('canvas');
      oc.width = pipe.w;
      oc.height = pipe.h;
      oc.style.cssText = cv.style.cssText;
      (document.body || document.documentElement).appendChild(oc);
      pipe.canvas = oc;
      pipe.out2d = oc.getContext('2d');
    }
    pipe.glr = null;
    pipe.glCv = cv;
    pipe.glFailed = false;
    if (deferGL && OUT_VIA_2D) {
      pipe.ctx2d = pipe.out2d; // WebGLは、顔認識の準備が済んでから作る
      return;
    }
    initGLPart(pipe);
  }
  function initGLPart(pipe) {
    var cv = pipe.glCv;
    var gl = null;
    try {
      gl = cv.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance'
      });
    } catch (e) {
      gl = null;
    }
    if (!gl) {
      pipe.glFailed = true;
      log('WebGL2が使えない：出力は待機画面だけになる');
      pipe.ctx2d = pipe.out2d || cv.getContext('2d');
      return;
    }
    try {
      var g = { gl: gl };
      g.prog = linkProgram(gl, VS_MAIN, FS_MAIN);
      g.blit = linkProgram(gl, VS_BLIT, FS_BLIT);
      g.loc = {};
      ['uAspect', 'uN', 'uC', 'uR', 'uTex', 'uMask', 'uTexel', 'uRad', 'uSmooth', 'uWrinkle', 'uSpot', 'uDebug', 'uNoseK', 'uNoseA', 'uNoseB', 'uFw'].forEach(function (nm) {
        g.loc[nm] = gl.getUniformLocation(g.prog, nm);
      });
      g.locBlitTex = gl.getUniformLocation(g.blit, 'uTex');
      // 格子
      var vx = GX + 1;
      var vy = GY + 1;
      var verts = new Float32Array(vx * vy * 2);
      var ix;
      var iy;
      for (iy = 0; iy < vy; iy++) {
        for (ix = 0; ix < vx; ix++) {
          verts[(iy * vx + ix) * 2] = ix / GX;
          verts[(iy * vx + ix) * 2 + 1] = iy / GY;
        }
      }
      var idx = new Uint16Array(GX * GY * 6);
      var q = 0;
      for (iy = 0; iy < GY; iy++) {
        for (ix = 0; ix < GX; ix++) {
          var a = iy * vx + ix;
          var b = a + 1;
          var c = a + vx;
          var d = c + 1;
          idx[q++] = a;
          idx[q++] = b;
          idx[q++] = c;
          idx[q++] = b;
          idx[q++] = d;
          idx[q++] = c;
        }
      }
      g.nIdx = idx.length;
      g.vao = gl.createVertexArray();
      gl.bindVertexArray(g.vao);
      var vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      var eb = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, eb);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      g.vaoEmpty = gl.createVertexArray();
      g.tex = makeTex(gl);
      g.maskTex = makeTex(gl);
      g.stbTex = makeTex(gl);
      // 美肌のマスク用の小さなキャンバス（256 x 高さ比）
      g.maskCanvas = document.createElement('canvas');
      g.maskCanvas.width = 256;
      g.maskCanvas.height = Math.max(16, Math.round((256 * pipe.h) / pipe.w));
      g.maskCtx = g.maskCanvas.getContext('2d');
      // 待機画面用の2Dキャンバス
      g.stbCanvas = document.createElement('canvas');
      g.stbCanvas.width = 480;
      g.stbCanvas.height = Math.max(16, Math.round((480 * pipe.h) / pipe.w));
      g.stbCtx = g.stbCanvas.getContext('2d');
      g.stbReason = null;
      pipe.glr = g;
      pipe.glCanvas = cv;
      var dbg = null;
      try {
        dbg = gl.getExtension('WEBGL_debug_renderer_info');
      } catch (e) {}
      log(
        'WebGL2 準備OK ' + gl.getParameter(gl.VERSION) + '／描画装置=' + (dbg ? short(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), 60) : '不明') +
          '／頂点の配列上限=' + gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) + '／制御点の最大=' + MAXC
      );
      cv.addEventListener('webglcontextlost', function (ev) {
        ev.preventDefault();
        pipe.glLost = true;
        log('WebGLの描画が失われた（contextlost）');
      });
    } catch (e) {
      pipe.glFailed = true;
      log('WebGLの準備に失敗: ' + short(errText(e), 160));
      pipe.glr = null;
      try {
        pipe.ctx2d = pipe.out2d || cv.getContext('2d');
      } catch (e2) {}
    }
  }
  function renderStandby(pipe, reason) {
    var g = pipe.glr;
    if (!g) {
      var c2 = pipe.ctx2d;
      if (c2) {
        c2.fillStyle = '#222222';
        c2.fillRect(0, 0, pipe.w, pipe.h);
        c2.fillStyle = '#dddddd';
        c2.font = 'bold ' + Math.round(Math.min(pipe.w, pipe.h) * 0.06) + 'px sans-serif';
        c2.textAlign = 'center';
        c2.fillText('待機中', pipe.w / 2, pipe.h * 0.47);
        c2.font = Math.round(Math.min(pipe.w, pipe.h) * 0.04) + 'px sans-serif';
        c2.fillText('（' + reason + '）', pipe.w / 2, pipe.h * 0.55);
      }
      return;
    }
    var gl = g.gl;
    if (g.stbReason !== reason) {
      var sc = g.stbCtx;
      var sw = g.stbCanvas.width;
      var sh = g.stbCanvas.height;
      sc.fillStyle = '#222222';
      sc.fillRect(0, 0, sw, sh);
      sc.fillStyle = '#dddddd';
      sc.font = 'bold ' + Math.round(Math.min(sw, sh) * 0.06) + 'px sans-serif';
      sc.textAlign = 'center';
      sc.fillText('待機中', sw / 2, sh * 0.47);
      sc.font = Math.round(Math.min(sw, sh) * 0.04) + 'px sans-serif';
      sc.fillText('（' + reason + '）', sw / 2, sh * 0.55);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, g.stbTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.stbCanvas);
      g.stbReason = reason;
    }
    gl.viewport(0, 0, pipe.w, pipe.h);
    gl.useProgram(g.blit);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, g.stbTex);
    gl.uniform1i(g.locBlitTex, 2);
    gl.bindVertexArray(g.vaoEmpty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
  function fillMaskPoly(ctx, P, color) {
    if (P.length < 3) return;
    ctx.beginPath();
    for (var i = 0; i < P.length; i++) {
      if (i === 0) ctx.moveTo(P[i][0], P[i][1]);
      else ctx.lineTo(P[i][0], P[i][1]);
    }
    ctx.closePath();
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.fillStyle = color;
    ctx.fill();
  }
  function expandPoly(P, k) {
    var cx = 0;
    var cy = 0;
    var i;
    for (i = 0; i < P.length; i++) {
      cx += P[i][0];
      cy += P[i][1];
    }
    cx /= P.length;
    cy /= P.length;
    var out = [];
    for (i = 0; i < P.length; i++) out.push([cx + (P[i][0] - cx) * k, cy + (P[i][1] - cy) * k]);
    return out;
  }
  function drawSkinMask(g, pts) {
    var ctx = g.maskCtx;
    var mw = g.maskCanvas.width;
    var mh = g.maskCanvas.height;
    function pt(i) {
      return [pts[i].x * mw, pts[i].y * mh];
    }
    function setHull(ids, k) {
      var a = [];
      for (var i = 0; i < ids.length; i++) a.push(pt(ids[i]));
      return expandPoly(hull(a), k);
    }
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, mw, mh);
    var oval = [];
    for (var i = 0; i < FACE_OVAL.length; i++) oval.push(pt(FACE_OVAL[i]));
    fillMaskPoly(ctx, expandPoly(oval, 0.97), '#fff');
    fillMaskPoly(ctx, setHull(MASK_EYE_R, 1.35), '#000');
    fillMaskPoly(ctx, setHull(MASK_EYE_L, 1.35), '#000');
    fillMaskPoly(ctx, setHull(MASK_BROW_R, 1.25), '#000');
    fillMaskPoly(ctx, setHull(MASK_BROW_L, 1.25), '#000');
    fillMaskPoly(ctx, setHull(MASK_LIPS, 1.2), '#000');
    fillMaskPoly(ctx, setHull(MASK_NOSE_BOTTOM, 1.25), '#000');
    ctx.shadowBlur = 0;
  }
  function renderWarp(pipe, pts) {
    var g = pipe.glr;
    var gl = g.gl;
    var w = pipe.w;
    var h = pipe.h;
    var n = buildControls(pts, w, h);
    var beauty = params.smooth > 0.001 || params.wrinkle > 0.001 || params.spot > 0.001;
    gl.viewport(0, 0, w, h);
    gl.useProgram(g.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, g.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, pipe.video);
    if (beauty || maskDebug) {
      drawSkinMask(g, pts);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, g.maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, g.maskCanvas);
    }
    var L = g.loc;
    gl.uniform1i(L.uTex, 0);
    gl.uniform1i(L.uMask, 1);
    gl.uniform1f(L.uAspect, w / h);
    gl.uniform1i(L.uN, n);
    gl.uniform4fv(L.uC, CP);
    gl.uniform1fv(L.uR, CR);
    gl.uniform2f(L.uTexel, 1 / w, 1 / h);
    var fwPx = Math.abs(pts[454].x - pts[234].x) * w;
    gl.uniform1f(L.uRad, Math.max(1.5, fwPx * 0.01));
    gl.uniform1f(L.uSmooth, params.smooth);
    gl.uniform1f(L.uWrinkle, params.wrinkle);
    gl.uniform1f(L.uSpot, params.spot);
    gl.uniform1f(L.uDebug, maskDebug ? 1 : 0);
    var asp = w / h;
    gl.uniform1f(L.uNoseK, params.noseHigh);
    gl.uniform2f(L.uNoseA, pts[168].x * asp, pts[168].y);
    gl.uniform2f(L.uNoseB, ((pts[1].x + pts[4].x) / 2) * asp, (pts[1].y + pts[4].y) / 2);
    gl.uniform1f(L.uFw, Math.abs(pts[454].x - pts[234].x) * asp);
    gl.bindVertexArray(g.vao);
    gl.drawElements(gl.TRIANGLES, g.nIdx, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    if (!g.errChecked) {
      g.errChecked = true;
      var er = gl.getError();
      log('最初の描画後のWebGLエラー=' + er + '（0なら正常）／制御点' + n + '個');
    }
  }

  // ====== 1コマの処理 ======
  function noteLag(lag) {
    S.lagCam = lag;
    lagSum += lag;
    lagN++;
    if (lag > lagMax) lagMax = lag;
    if (curPhase) {
      curPhase.lagSum += lag;
      curPhase.lagN++;
      if (lag > curPhase.lagMax) curPhase.lagMax = lag;
    }
  }
  function processFrame(pipe, now, meta) {
    var tStart = performance.now();
    var reason = null;
    var pts = null;
    var res = null;

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
        updatePose(res);
        reason = checkPose(pts);
      }
    }
    if (!reason && (!pipe.glr || pipe.glLost)) reason = pipe.glLost ? 'WebGL喪失' : pipe.glFailed ? 'WebGLなし' : 'WebGL準備中';

    var tDraw = performance.now();
    if (!reason) {
      try {
        renderWarp(pipe, pts);
      } catch (e) {
        reason = '描画エラー';
        drawErrCount++;
        if (drawErrCount <= 3) log('描画で例外 ' + short(errText(e), 120));
      }
    }
    if (reason) {
      try {
        renderStandby(pipe, reason);
      } catch (e) {
        log('待機画面の描画で例外 ' + short(errText(e), 100));
      }
      reasonCount[reason] = (reasonCount[reason] || 0) + 1;
      winStandby++;
      if (curPhase) curPhase.standby++;
      if (wasFace && reason !== '読み込み中') {
        lostCount++;
        if (curPhase) curPhase.lost++;
        if (reason === '顔を見失い') stopsN++;
        lostInfo = { t: performance.now(), reason: reason, ang: lastAng };
      }
      wasFace = false;
    } else {
      winFace++;
      if (curPhase) curPhase.frames++;
      if (lostInfo) {
        var a = lostInfo.ang;
        var dur = (performance.now() - lostInfo.t) / 1000;
        log(
          '停止(' + lostInfo.reason + ')→復帰 待機' + r2(dur) + '秒｜直前の向き 左右' + (a ? fa(a.yawM) : '-') + '° 上下' +
            (a ? fa(a.pitchM) : '-') + '°'
        );
        lostInfo = null;
      }
      wasFace = true;
      lastAng = { yawM: yawM, pitchM: pitchM };
    }
    if (pipe.out2d && pipe.glCanvas) {
      try {
        pipe.out2d.drawImage(pipe.glCanvas, 0, 0, pipe.w, pipe.h);
      } catch (e) {
        copyErrCount++;
        if (copyErrCount <= 3) log('出力への写しで例外 ' + short(errText(e), 100));
      }
    }
    var tEnd = performance.now();
    drawSamples.push(tEnd - tDraw);
    C.out++;
    var proc = tEnd - tStart;
    procSamples.push(proc);
    if (proc > runProcMax) runProcMax = proc;
    if (meta && typeof meta.captureTime === 'number') noteLag(Math.max(0, performance.now() - meta.captureTime));
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

  // ====== 試験の進行（プリセットを順に切り替える。各局面で「自然／不自然」を押す） ======
  function endPhase() {
    var p = curPhase;
    if (!p) return;
    var s = p.secs || 1;
    var tot = p.frames + p.standby;
    log(
      '【試験' + (curPhaseIdx + 1) + ' ' + PRESETS[curPhaseIdx].name + '】' + p.secs + '秒 出力' + r1(p.out / s) + '枚/秒 検出' +
        r1(p.det / s) + 'ms 処理' + r1(p.proc / s) + 'ms 描画' + r1(p.draw / s) + 'ms｜待機' + (tot ? r0((100 * p.standby) / tot) : 0) +
        '% 見失い' + p.lost + '｜カメラ遅れ 平均' + (p.lagN ? r0(p.lagSum / p.lagN) : '-') + 'ms 最大' + (p.lagN ? r0(p.lagMax) : '-') + 'ms'
    );
    curPhase = null;
  }
  function runPhase(pipe, k) {
    if (pipe.stopped) return;
    endPhase();
    if (k >= PRESETS.length) {
      applyPreset(0);
      curPresetName = '手動';
      promptText = '【自動試験は終了】「調整」で好みに動かし、「自然／不自然」を押す。最後に「ログをコピー」';
      promptEnd = 0;
      log('自動試験は終了。以降は手動（スライダーで調整できる）');
      return;
    }
    curPhaseIdx = k;
    curPhase = newAcc();
    applyPreset(k);
    promptText = '【試験' + (k + 1) + '/' + PRESETS.length + '】' + PRESETS[k].name + '｜自分の顔を見て「自然／少し不自然／不自然」を押す';
    promptEnd = performance.now() + PHASE_SEC * 1000 * TS;
    log('試験' + (k + 1) + '/' + PRESETS.length + ' 開始：' + PRESETS[k].name + ' | ' + paramsText());
    pipe.timers.push(
      setTimeout(function () {
        runPhase(pipe, k + 1);
      }, PHASE_SEC * 1000 * TS)
    );
  }
  function startSession(pipe) {
    if (pipe.sess || pipe.stopped) return;
    if (window.__v8NoAuto) return; // 擬似環境の試験用。通常は動かない
    pipe.sess = true;
    log('試験の進行を開始。画面の指示のとおり、正面を向いて自分の顔を見る');
    runPhase(pipe, 0);
  }

  // ====== 数字の更新（1秒ごと） ======
  function avgMax(a) {
    var s = 0;
    var m = 0;
    for (var i = 0; i < a.length; i++) {
      s += a[i];
      if (a[i] > m) m = a[i];
    }
    return [a.length ? s / a.length : 0, m];
  }
  function logSummary(sec) {
    log(
      '【経過' + sec + '秒】出力' + S.out + ' 検出' + S.det + ' 検出' + r1(S.detAvg) + 'ms(最大' + r0(runDetMax) + ') 処理' +
        r1(S.procAvg) + 'ms(最大' + r0(runProcMax) + ') 描画' + r1(S.drawAvg) + 'ms 見失い' + lostCount + ' 待機' + S.standbyPct +
        '% カメラ遅れ平均' + (lagN ? r0(lagSum / lagN) : '-') + 'ms 最大' + r0(lagMax) + 'ms｜最大の向き 左+' + r0(maxYaw[0]) + '/右' + r0(maxYaw[1]) +
        '｜評価 自然' + ratingN.good + ' 少し不自然' + ratingN.so + ' 不自然' + ratingN.bad
    );
    log('待機の内訳 ' + safeJson(reasonCount));
  }
  function tickStats() {
    S.out = C.out;
    S.det = C.det;
    C.out = 0;
    C.det = 0;
    var d = avgMax(detSamples);
    var p = avgMax(procSamples);
    var m = avgMax(drawSamples);
    S.detAvg = d[0];
    S.procAvg = p[0];
    S.drawAvg = m[0];
    detSamples = [];
    procSamples = [];
    drawSamples = [];
    var tot = winFace + winStandby;
    S.standbyPct = tot ? Math.round((100 * winStandby) / tot) : 0;
    winFace = 0;
    winStandby = 0;
    if (curPhase) {
      var a = curPhase;
      a.secs++;
      a.out += S.out;
      a.proc += S.procAvg;
      a.det += S.detAvg;
      a.draw += S.drawAvg;
    }
    updateHead();
  }

  // ====== パイプライン（本物のカメラ→顔認識→変形・美肌→出力）の開始と停止 ======
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
        pipe.w = v.videoWidth || 960;
        pipe.h = v.videoHeight || 720;
        initOutput(pipe, true);
        log('出力の大きさ ' + pipe.w + 'x' + pipe.h + '（WebGLは顔認識の準備後に作る）');
        renderStandby(pipe, '起動中');
        startLoop(pipe);
        pipe.timers.push(setInterval(tickStats, 1000));
        [60, 180, 300, 600].forEach(function (sec) {
          pipe.timers.push(
            setTimeout(function () {
              if (!pipe.stopped) logSummary(sec);
            }, sec * 1000 * TS)
          );
        });
        loadMediaPipe().then(
          function () {
            if (pipe.stopped) return;
            warmUp(pipe);
            if (OUT_VIA_2D) initGLPart(pipe);
            startSession(pipe);
          },
          function () {
            log('顔認識が使えないため、WebGLは準備せず、試験の進行も始めない');
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
      if (pipe.glCanvas && pipe.glCanvas.parentNode) pipe.glCanvas.parentNode.removeChild(pipe.glCanvas);
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
        wrapTrack(vt, 'V8b出力');
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

  // 擬似環境の試験用（通常は動かない）
  if (window.__v8TestMode) {
    window.__v8Hook = { applyPreset: applyPreset, setParam: setParam, params: params, PRESETS: PRESETS, PARAM_DEFS: PARAM_DEFS };
  }

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
