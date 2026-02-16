// road-condition-predict.js
// FMS投稿データから路面状況スコア(0-100)を予測する

(function() {
  'use strict';

  // レベル分類テーブル
  var LEVELS = [
    { min: 0,  max: 20,  level: 'clear',    snow: 'なし',   surface: '乾燥', danger: '安全',       label: '良好',       color: '#27ae60' },
    { min: 21, max: 40,  level: 'caution',  snow: '薄い',   surface: '湿潤', danger: '注意',       label: '注意',       color: '#f39c12' },
    { min: 41, max: 60,  level: 'warning',  snow: '中程度', surface: '圧雪', danger: '注意',       label: '警戒',       color: '#e67e22' },
    { min: 61, max: 80,  level: 'danger',   snow: '多い',   surface: '凍結', danger: '危険',       label: '危険',       color: '#c0392b' },
    { min: 81, max: 100, level: 'critical', snow: '多い',   surface: '凍結', danger: 'スタック',   label: 'スタック注意', color: '#7b241c' },
  ];

  function classify(score) {
    var s = Math.max(0, Math.min(100, Math.round(score)));
    for (var i = 0; i < LEVELS.length; i++) {
      if (s <= LEVELS[i].max) {
        return Object.assign({}, LEVELS[i], { score: s });
      }
    }
    return Object.assign({}, LEVELS[LEVELS.length - 1], { score: s });
  }

  // 自エリアのrawスコアを計算
  function calcSelfScore(area) {
    if (!area || !area.risk) return null;
    var r = area.risk;
    var total = area.total || 0;
    if (total === 0) return null;

    // 重み付き severity
    var rawSeverity = (5 * (r.stacked || 0) + 3 * (r.near_stack || 0) + 1.5 * (r.passable_slow || 0) - 2 * (r.resolved || 0)) / total;

    // days_since_snow 補正
    var dayCorr = 0;
    var days = area.days_since_snow;
    if (days != null) {
      if (days <= 1)      dayCorr = -0.3;
      else if (days <= 3) dayCorr = 0;
      else if (days <= 5) dayCorr = 0.3;
      else                dayCorr = 0.6;
    } else {
      dayCorr = 0.3; // 不明は少し悪めに
    }

    // shirei 補正
    var shireiCorr = 0;
    var shirei = area.shirei || '';
    if (shirei.indexOf('継続') >= 0) shireiCorr = 0.3;
    else if (shirei.indexOf('新規') >= 0) shireiCorr = 0.5;

    // 正規化: rawSeverity の理論最大は約5（全件stacked）、最小は約-2（全件resolved）
    // 補正込みで -2 ~ 6.1 程度の範囲 → 0-100にマッピング
    var combined = rawSeverity + dayCorr + shireiCorr;
    var score = ((combined + 2) / 8.1) * 100;
    return Math.max(0, Math.min(100, score));
  }

  // 全エリアの予測を計算
  function predictAllAreas(fmsRisk, areasMeta) {
    var selfScores = {};
    var areas = fmsRisk.areas || fmsRisk;

    // Step 1: 全エリアの自己スコアを計算
    for (var name in areas) {
      selfScores[name] = calcSelfScore(areas[name]);
    }

    var predictions = {};

    // Step 2 & 3: 隣接ブレンド
    for (var name in areas) {
      var area = areas[name];
      var selfScore = selfScores[name];
      var total = (area && area.total) || 0;

      // 隣接エリアの平均スコアを計算
      var neighborScores = [];
      var metaEntry = areasMeta[name];
      if (metaEntry && metaEntry.neighbors) {
        for (var i = 0; i < metaEntry.neighbors.length; i++) {
          var ns = selfScores[metaEntry.neighbors[i]];
          if (ns != null) neighborScores.push(ns);
        }
      }
      var neighborAvg = neighborScores.length > 0
        ? neighborScores.reduce(function(a, b) { return a + b; }, 0) / neighborScores.length
        : null;

      // ブレンド比率を決定
      var finalScore, source, confidence;
      if (selfScore != null && neighborAvg != null) {
        var selfWeight;
        if (total >= 15)     selfWeight = 0.85;
        else if (total >= 8) selfWeight = 0.70;
        else if (total >= 3) selfWeight = 0.55;
        else                 selfWeight = 0.35;

        finalScore = selfScore * selfWeight + neighborAvg * (1 - selfWeight);
        source = 'blend';
        confidence = total >= 15 ? 'high' : total >= 8 ? 'medium' : 'low';
      } else if (selfScore != null) {
        finalScore = selfScore;
        source = 'self';
        confidence = total >= 8 ? 'medium' : 'low';
      } else if (neighborAvg != null) {
        finalScore = neighborAvg;
        source = 'neighbor';
        confidence = 'estimate';
      } else {
        finalScore = 50; // データなし→中間値
        source = 'none';
        confidence = 'estimate';
      }

      var result = classify(finalScore);
      result.source = source;
      result.confidence = confidence;
      result.selfScore = selfScore != null ? Math.round(selfScore) : null;
      result.neighborAvg = neighborAvg != null ? Math.round(neighborAvg) : null;
      result.total = total;

      predictions[name] = result;
    }

    // areasMeta にあるが fmsRisk にないエリアも隣接から推定
    for (var name in areasMeta) {
      if (predictions[name]) continue;
      var metaEntry = areasMeta[name];
      var neighborScores = [];
      if (metaEntry && metaEntry.neighbors) {
        for (var i = 0; i < metaEntry.neighbors.length; i++) {
          var pred = predictions[metaEntry.neighbors[i]];
          if (pred) neighborScores.push(pred.score);
        }
      }
      if (neighborScores.length > 0) {
        var avg = neighborScores.reduce(function(a, b) { return a + b; }, 0) / neighborScores.length;
        var result = classify(avg);
        result.source = 'neighbor';
        result.confidence = 'estimate';
        result.selfScore = null;
        result.neighborAvg = Math.round(avg);
        result.total = 0;
        predictions[name] = result;
      }
    }

    return predictions;
  }

  // 信頼度ラベル
  var CONFIDENCE_LABELS = {
    high: '高（投稿15件以上）',
    medium: '中（投稿8件以上）',
    low: '低（投稿少数）',
    estimate: '推定（隣接エリアから）',
  };

  var SOURCE_LABELS = {
    blend: '自エリア＋隣接ブレンド',
    self: '自エリアのみ',
    neighbor: '隣接エリアから推定',
    none: 'データ不足',
  };

  // グローバル公開
  window.RoadPredict = {
    predictAllAreas: predictAllAreas,
    classify: classify,
    LEVELS: LEVELS,
    CONFIDENCE_LABELS: CONFIDENCE_LABELS,
    SOURCE_LABELS: SOURCE_LABELS,
  };

})();
