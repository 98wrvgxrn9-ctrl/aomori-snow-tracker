(function() {
  var FACE_SMILE_THRESHOLD = 25;
  var FACE_FROWN_THRESHOLD = -25;
  var OPERATOR_CRY_SMALL = -45;
  var OPERATOR_CRY_MEDIUM = -65;
  var OPERATOR_CRY_LARGE = -85;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getConfidence(total) {
    if (total >= 10) return 'high';
    if (total >= 5) return 'medium';
    return 'low';
  }

  function faceFromScore(score) {
    if (score >= FACE_SMILE_THRESHOLD) return 'smile';
    if (score <= FACE_FROWN_THRESHOLD) return 'frown';
    return 'neutral';
  }

  function faceMeta(face) {
    if (face === 'smile') return { emoji: '😀', label: '笑顔', color: '#27ae60' };
    if (face === 'frown') return { emoji: '😟', label: '不満', color: '#c0392b' };
    return { emoji: '😐', label: '普通', color: '#6b7280' };
  }

  function formatScore(score) {
    return score > 0 ? ('+' + score) : String(score);
  }

  function getAreaFace(risk) {
    if (!risk || !risk.total || risk.total <= 0) {
      return { available: false, reason: 'no_data' };
    }

    var total = Number(risk.total) || 0;
    var resolved = Number((risk.risk && risk.risk.resolved) || risk.resolved || 0);
    var stacked = Number((risk.risk && risk.risk.stacked) || 0);
    var nearStack = Number((risk.risk && risk.risk.near_stack) || 0);
    var passableSlow = Number((risk.risk && risk.risk.passable_slow) || 0);

    var raw = (2 * resolved) - (3 * stacked) - (2 * nearStack) - (1 * passableSlow);
    var score = clamp(Math.round((100 * raw) / Math.max(total, 1)), -100, 100);
    var face = faceFromScore(score);
    var meta = faceMeta(face);

    return {
      available: true,
      score: score,
      scoreText: formatScore(score),
      face: face,
      emoji: meta.emoji,
      label: meta.label,
      color: meta.color,
      total: total,
      confidence: getConfidence(total)
    };
  }

  function getOperatorMood(posts) {
    var list = Array.isArray(posts) ? posts : [];
    return buildOperatorMoodFromPosts(list);
  }

  function getOperatorMoodForArea(areaName, posts) {
    var list = Array.isArray(posts) ? posts : [];
    var filtered = list.filter(function(p) {
      return p && p.area === areaName;
    });
    return buildOperatorMoodFromPosts(filtered);
  }

  function buildOperatorMoodFromPosts(list) {
    var contextRe = /除雪|排雪|除雪業者|業者|オペ|オペレーター|対応|作業|除雪車/;
    var positiveRe = /感謝|ありがとう|助か|迅速|丁寧|改善|解消|早い|除雪.*入っ/;
    var negativeRe = /遅い|雑|来ない|ひどい|対応悪|不満|最悪|放置/;

    var pos = 0;
    var neg = 0;
    var neutral = 0;

    for (var i = 0; i < list.length; i++) {
      var text = String((list[i] && list[i].text) || '');
      if (!contextRe.test(text)) continue;

      var hasPos = positiveRe.test(text);
      var hasNeg = negativeRe.test(text);

      if (hasPos && !hasNeg) {
        pos++;
      } else if (hasNeg && !hasPos) {
        neg++;
      } else {
        neutral++;
      }
    }

    var total = pos + neg + neutral;
    var score = 0;
    if (total > 0) {
      var raw = pos - neg;
      score = clamp(Math.round((100 * raw) / total), -100, 100);
    }

    // 業者は通常状態をデフォルト。負の強さに応じて泣きレベルを上げる。
    var face = 'normal';
    if (score <= OPERATOR_CRY_LARGE) {
      face = 'cry_large';
    } else if (score <= OPERATOR_CRY_MEDIUM) {
      face = 'cry_medium';
    } else if (score <= OPERATOR_CRY_SMALL) {
      face = 'cry_small';
    }
    var meta = operatorFaceMeta(face);

    return {
      available: true,
      score: score,
      scoreText: formatScore(score),
      face: face,
      emoji: meta.emoji,
      label: meta.label,
      color: meta.color,
      total: total,
      confidence: getConfidence(total),
      positive: pos,
      negative: neg,
      neutral: neutral
    };
  }

  function operatorFaceMeta(face) {
    if (face === 'cry_small') return { emoji: '😢', label: '小泣き', color: '#3b82f6' };
    if (face === 'cry_medium') return { emoji: '😭', label: '中泣き', color: '#2563eb' };
    if (face === 'cry_large') return { emoji: '😭', label: '大泣き', color: '#1d4ed8' };
    return { emoji: '😐', label: '普通', color: '#6b7280' };
  }

  window.FaceScore = {
    getAreaFace: getAreaFace,
    getOperatorMood: getOperatorMood,
    getOperatorMoodForArea: getOperatorMoodForArea
  };
})();
