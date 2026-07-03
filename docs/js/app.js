    // 応援除雪の作業予定期間を [start, end] (Date) で返す
    function parsePeriodDates(str) {
      if (!str || !str.trim()) return [null, null];
      const parts = str.split(/[～〜~]/);
      function pd(s) {
        if (!s) return null;
        const m = s.match(/(\d+)月\s*(\d+)日/);
        if (!m) return null;
        const d = new Date(new Date().getFullYear(), parseInt(m[1]) - 1, parseInt(m[2]));
        d.setHours(0, 0, 0, 0);
        return d;
      }
      return [pd(parts[0] || ''), pd(parts[1] || '')];
    }

    // ステータス判定（部分一致）
    function classifyStatus(raw) {
      if (!raw) return 'other';
      if (raw.includes('作業予定あり') || raw.includes('作業中')) return 'scheduled';
      if (raw.includes('現場確認中')) return 'checking';
      if (raw.includes('作業日程調整中')) return 'adjusting';
      return 'other';
    }

    const STATUS_CONFIG = {
      scheduled:  { color: '#e74c3c', label: '作業予定あり', bg: '#e74c3c' },
      checking:   { color: '#3498db', label: '現場確認中',   bg: '#3498db' },
      adjusting:  { color: '#e67e22', label: '日程調整中',   bg: '#e67e22' },
      other:      { color: '#95a5a6', label: 'その他',       bg: '#95a5a6' },
    };

    function getColor(status) {
      const cls = classifyStatus(status);
      return STATUS_CONFIG[cls].color;
    }

    // 地図初期化
    const DEFAULT_CENTER = [40.8227, 140.7380];
    const DEFAULT_ZOOM = 13;
    const map = L.map('map').setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(map);

    // 全フィーチャー管理
    let allFeatures = [];
    let allLayers = [];
    let selectedLayer = null;
    let xPostsData = [];  // X投稿データ
    let areasMeta = {};   // 工区メタデータ（centroid, bbox, neighbors）
    let dumpSites = [];   // 雪捨て場データ
    let ryusetsukoData = []; // 流雪溝施設データ
    let busStatusData = null; // 市営バス運行状況
    let kokudoFeatures = []; // 国道除雪状況
    let supportZones = [];   // 応援除雪工区（県財政支援）
    let kosodateEvents = []; // 子育て・学びイベント
    let kidsEventMarkers = {}; // 子育てイベントマーカー
    let kosodateWindow = null; // イベント抽出期間
    let kosodateMonitoring = null; // 子育てページ監視メタ
    let fmsCounts = {};      // FMS関心度（工区/路線名→レベル）
    let fmsRisk = {};        // FMSリスクデータ（工区名→{total, stuck_total, ...}）
    let prevSummary = null;  // 前日サマリー
    let roadPredictions = {}; // 路面状況予測
    let busSuspendedData = null; // バス運休路線GeoJSON
    let busLayers = [];          // バス運休路線のLeafletレイヤー群
    let busLayersVisible = false; // バス路線表示状態
    let spaneData = null;         // スパネ度指数
    let routeLayer = null;       // ルート描画用LayerGroup
    let naviOriginArea = null;   // 出発エリア名
    let naviDestArea = null;     // 目的地エリア名
    let naviGpsCoords = null;    // GPS座標
    let naviTransportMode = null; // 'car' | 'walk_bike' | 'bus'
    let naviPickMode = null;     // 地図選択モード: 'origin' | 'dest' | null
    let naviSkipReset = false;   // map選択後の復帰時に入力保持
    let naviRouteCandidates = []; // 候補ルート一覧
    let naviSelectedRouteIndex = 0;
    let pendingRouteResult = null; // 検索結果保持

    // レイヤーグループ
    const dumpSiteLayer = L.layerGroup();
    const ryusetsukoLayer = L.layerGroup();
    const kokudoLayer = L.layerGroup();
    const busLayer = L.layerGroup();
    const supportLayer = L.layerGroup();
    const kokuLayer = L.layerGroup();
    const spaneLayer = L.layerGroup();
    const kidsAdminLayer = L.layerGroup();
    const kidsPrivateLayer = L.layerGroup();
    const layerVisibility = { koku: true, dump: true, ryusetsuko: true, kokudo: true, bus: false, support: true, spane: false, kids_admin: false, kids_private: false };
    const kokuStatusVisibility = { scheduled: true, checking: true, adjusting: true };
    const layerGroupMap = { koku: kokuLayer, dump: dumpSiteLayer, ryusetsuko: ryusetsukoLayer, kokudo: kokudoLayer, bus: busLayer, support: supportLayer, spane: spaneLayer, kids_admin: kidsAdminLayer, kids_private: kidsPrivateLayer };
    const FEATURE_VIDEO_URL = ''; // 例: 'https://www.youtube.com/embed/xxxxxxxxxxx'

    // ビュー管理
    let currentView = 'hub';
    let dataReady = false;
    let activePurposeKey = null;
    let mapHeaderTitle = '除排雪マップ';
    let panelHeaderTitle = '除排雪状況';
    let panelHeaderSubtitle = 'エリアをクリックすると詳細を表示';
    let kidsAccordionState = { monthly: true, recent: true };

    const purposeConfigs = {
      mobility: {
        mapTitle: '移動マップ',
        panelTitle: '移動情報',
        panelSubtitle: 'バス運行・道路関連レイヤーを表示中',
        layers: { koku: true, dump: false, ryusetsuko: false, kokudo: true, bus: true, support: false, spane: false, kids_admin: false, kids_private: false },
      },
      living: {
        mapTitle: '暮らしマップ',
        panelTitle: '暮らし情報',
        panelSubtitle: '生活関連レイヤーを表示中',
        layers: { koku: false, dump: true, ryusetsuko: true, kokudo: false, bus: false, support: false, spane: false, kids_admin: false, kids_private: false },
      },
      safety: {
        mapTitle: '安全マップ',
        panelTitle: '安全情報',
        panelSubtitle: '安全判断向けに広めの情報を表示中',
        layers: { koku: true, dump: true, ryusetsuko: true, kokudo: true, bus: true, support: true, spane: true, kids_admin: false, kids_private: false },
      },
      learning: {
        mapTitle: '子育て学びマップ',
        panelTitle: '子育て学び情報',
        panelSubtitle: '子育て・子どもイベントを表示中',
        layers: { koku: false, dump: false, ryusetsuko: false, kokudo: false, bus: false, support: false, spane: false, kids_admin: true, kids_private: true },
      },
    };

    function syncMapHeader() {
      const titleEl = document.getElementById('header-title');
      if (titleEl && currentView === 'map') {
        titleEl.textContent = mapHeaderTitle;
      }
      const panelTitleEl = document.getElementById('panel-title');
      const panelSubtitleEl = document.getElementById('panel-subtitle');
      if (panelTitleEl) panelTitleEl.textContent = panelHeaderTitle;
      if (panelSubtitleEl) panelSubtitleEl.textContent = panelHeaderSubtitle;
    }

    function setPanelSectionDisplay(id, display) {
      const el = document.getElementById(id);
      if (!el) return;
      el.style.display = display;
    }

    function kidsCategoryLabel(category) {
      if (category === 'private_general') return '民間一般';
      return '行政';
    }

    function kidsCategoryColor(category) {
      if (category === 'private_general') return '#0284c7';
      return '#be185d';
    }

    function isMonthlyKidsEvent(ev) {
      const txt = `${ev.month || ''} ${ev.time || ''}`;
      return txt.includes('毎月') || txt.includes('毎週') || txt.includes('通年') || txt.includes('4月-3月');
    }

    function renderKidsEventRows(events) {
      let html = '';
      events.forEach(function(ev) {
        const title = escapeHtml(ev.title || '子育てイベント');
        const month = escapeHtml(ev.month || '未設定');
        const time = escapeHtml(ev.time || '未設定');
        const summary = escapeHtml(ev.summary || '');
        const catLabel = kidsCategoryLabel(ev.category);
        const catColor = kidsCategoryColor(ev.category);
        const id = ev.id || '';
        const safeId = escapeHtml(id);
        const safeUrl = (ev.url && /^https?:\/\//.test(ev.url)) ? ev.url : '#';
        html += '<div style="border-top:1px solid #fce7f3;padding:8px 0">';
        html += '<div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start">';
        html += '<div style="font-size:13px;font-weight:bold;color:#9d174d;line-height:1.4">' + title + '</div>';
        html += '<span style="font-size:10px;background:' + catColor + ';color:#fff;padding:2px 6px;border-radius:999px;white-space:nowrap">' + catLabel + '</span>';
        html += '</div>';
        html += '<div style="font-size:11px;color:#4b5563;margin-top:3px">何月: ' + month + ' / 何時: ' + time + '</div>';
        if (summary) html += '<div style="font-size:11px;color:#6b7280;margin-top:2px;line-height:1.4">' + summary + '</div>';
        html += '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">';
        html += '<button type="button" data-action="focus-kids-event" data-arg="' + safeId + '" style="background:#fdf2f8;color:#9d174d;border:1px solid #f9a8d4;border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer">地図で見る</button>';
        html += '<a href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener" style="background:#be185d;color:#fff;text-decoration:none;border-radius:6px;padding:5px 8px;font-size:11px;font-weight:bold">申込/詳細</a>';
        html += '</div></div>';
      });
      return html;
    }

    function renderKidsDashboard() {
      const container = document.getElementById('kids-dashboard');
      if (!container) return;
      const count = kosodateEvents.length;
      const monthlyEvents = kosodateEvents.filter(isMonthlyKidsEvent);
      const recentEvents = kosodateEvents.filter(ev => !isMonthlyKidsEvent(ev));
      const monthlyOpen = kidsAccordionState.monthly;
      const recentOpen = kidsAccordionState.recent;
      let html = '<div style="background:#fff;border:1px solid #fbcfe8;border-radius:10px;padding:10px 12px;margin-bottom:10px">';
      html += '<h3 style="font-size:14px;color:#be185d;margin-bottom:6px">子育て・子どもイベント一覧</h3>';
      html += '<div style="font-size:11px;color:#6b7280;margin-bottom:8px">ピンを押すか、一覧から地図上へ移動できます（' + count + '件）。</div>';
      if (kosodateMonitoring && (kosodateMonitoring.checked_at || kosodateMonitoring.next_check_at || kosodateMonitoring.note)) {
        const monitorStatus = kosodateMonitoring.status || 'ok';
        const monitorBg = monitorStatus === 'attention' ? '#fff7ed' : '#f0fdf4';
        const monitorBorder = monitorStatus === 'attention' ? '#fdba74' : '#86efac';
        const monitorText = monitorStatus === 'attention' ? '#9a3412' : '#166534';
        const checkedAt = escapeHtml(kosodateMonitoring.checked_at || '-');
        const nextCheckAt = escapeHtml(kosodateMonitoring.next_check_at || '-');
        html += '<div style="font-size:10px;color:' + monitorText + ';background:' + monitorBg + ';border:1px solid ' + monitorBorder + ';border-radius:8px;padding:7px 8px;margin-bottom:8px">';
        html += '最終確認: ' + checkedAt + ' / 次回監視目安: ' + nextCheckAt;
        if (kosodateMonitoring.note) {
          html += '<div style="margin-top:4px;line-height:1.5">' + escapeHtml(kosodateMonitoring.note) + '</div>';
        }
        html += '</div>';
      }
      if (kosodateWindow && kosodateWindow.start_date && kosodateWindow.end_date) {
        html += '<div style="font-size:10px;color:#6b7280;margin-bottom:8px">掲載期間: ' + escapeHtml(kosodateWindow.start_date) + ' 〜 ' + escapeHtml(kosodateWindow.end_date) + '</div>';
      }
      html += '<div style="border-top:1px solid #fce7f3;margin-top:6px">';
      html += '<button type="button" data-action="toggle-kids-accordion" data-arg="recent" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:#eff6ff;border:none;padding:8px 10px;color:#1d4ed8;font-size:12px;font-weight:bold;cursor:pointer">';
      html += '<span>直近3ヶ月（' + recentEvents.length + '件）</span>';
      html += '<span>' + (recentOpen ? '▲' : '▼') + '</span></button>';
      if (recentOpen) {
        html += renderKidsEventRows(recentEvents);
      }
      html += '</div>';
      html += '<div style="border-top:1px solid #fce7f3;margin-top:8px">';
      html += '<button type="button" data-action="toggle-kids-accordion" data-arg="monthly" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:#fff0f6;border:none;padding:8px 10px;color:#9d174d;font-size:12px;font-weight:bold;cursor:pointer">';
      html += '<span>毎月分（' + monthlyEvents.length + '件）</span>';
      html += '<span>' + (monthlyOpen ? '▲' : '▼') + '</span></button>';
      if (monthlyOpen) {
        html += renderKidsEventRows(monthlyEvents);
      }
      html += '</div>';
      html += '</div>';
      container.innerHTML = html;
    }

    window.toggleKidsAccordion = function(section) {
      if (section !== 'monthly' && section !== 'recent') return;
      kidsAccordionState[section] = !kidsAccordionState[section];
      renderKidsDashboard();
    };

    window.focusKidsEvent = function(eventId) {
      const entry = kidsEventMarkers[eventId];
      if (!entry) return;
      const targetKey = entry.category === 'private_general' ? 'kids_private' : 'kids_admin';
      if (!layerVisibility[targetKey]) {
        layerVisibility[targetKey] = true;
        layerGroupMap[targetKey].addTo(map);
        updateToggleCheckbox(targetKey);
        updateLegend();
      }
      map.setView(entry.marker.getLatLng(), 14);
      entry.marker.openPopup();
    };

    function updatePurposePanelLayout() {
      const isKidsMode = activePurposeKey === 'learning';
      const panelNote = document.getElementById('panel-context-note');
      if (panelNote) panelNote.style.display = isKidsMode ? 'none' : 'block';
      setPanelSectionDisplay('summary', isKidsMode ? 'none' : 'block');
      setPanelSectionDisplay('share-bar', 'none');
      setPanelSectionDisplay('fms-risk-panel', isKidsMode ? 'none' : 'block');
      setPanelSectionDisplay('selected-info', isKidsMode ? 'none' : 'block');
      setPanelSectionDisplay('x-posts-container', isKidsMode ? 'none' : 'block');
      setPanelSectionDisplay('area-list-section', 'none');
      setPanelSectionDisplay('bus-status', isKidsMode ? 'none' : 'block');
      setPanelSectionDisplay('kids-dashboard', isKidsMode ? 'block' : 'none');
      if (isKidsMode) renderKidsDashboard();
      renderPanelLayerControl();
    }

    function applyLayerPreset(preset) {
      if (!preset) return;
      Object.keys(layerVisibility).forEach(function(key) {
        if (!Object.prototype.hasOwnProperty.call(preset, key)) return;
        layerVisibility[key] = !!preset[key];
        const group = layerGroupMap[key];
        if (layerVisibility[key]) {
          group.addTo(map);
        } else {
          map.removeLayer(group);
        }
        updateToggleCheckbox(key);
      });
      if (!layerVisibility.koku) {
        selectedLayer = null;
        map.closePopup();
      } else {
        applyKokuStatusFilter();
      }
      busLayersVisible = layerVisibility.bus;
      const btn = document.getElementById('bus-map-toggle');
      if (btn) {
        if (busLayersVisible) {
          btn.textContent = '🗺 地図から非表示';
          btn.style.background = '#dc2626';
        } else {
          btn.textContent = '🗺 地図に表示';
          btn.style.background = '#f59e0b';
        }
      }
      renderSpaneLayer();
      renderSpanePanel();
      updateLegend();
    }

    window.selectPurpose = function(key) {
      const config = purposeConfigs[key];
      if (!config) {
        switchView('map');
        return;
      }
      activePurposeKey = key;
      mapHeaderTitle = config.mapTitle;
      panelHeaderTitle = config.panelTitle;
      panelHeaderSubtitle = config.panelSubtitle;
      switchView('map');
      applyLayerPreset(config.layers);
      syncMapHeader();
      updatePurposePanelLayout();
    };

    window.switchView = function(view) {
      if (view !== 'map') hideNaviPickBanner();

      // 全ビュー非表示
      document.getElementById('hub-view').style.display = 'none';
      document.getElementById('main').style.display = 'none';
      document.getElementById('dashboard-view').style.display = 'none';
      document.getElementById('navi-view').style.display = 'none';
      // 戻るボタン
      const backBtn = document.getElementById('back-btn');
      const titleEl = document.getElementById('header-title');

      if (view === 'hub') {
        document.getElementById('hub-view').style.display = 'flex';
        backBtn.style.display = 'none';
        titleEl.textContent = '青森市 除排雪スケジュールマップ';
        mapHeaderTitle = '除排雪マップ';
        panelHeaderTitle = '除排雪状況';
        panelHeaderSubtitle = 'エリアをクリックすると詳細を表示';
        activePurposeKey = null;
        syncMapHeader();
        updatePurposePanelLayout();
        if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
      } else if (view === 'map') {
        document.getElementById('main').style.display = 'flex';
        backBtn.style.display = 'block';
        titleEl.textContent = mapHeaderTitle;
        syncMapHeader();
        updatePurposePanelLayout();
        if (!naviPickMode) hideNaviPickBanner();
        setTimeout(function() {
          map.invalidateSize();
          if (allLayers.length > 0 && !selectedLayer) {
            const group = L.featureGroup(allLayers.map(l => l.layer));
            if (group.getBounds().isValid()) {
              map.fitBounds(group.getBounds(), { padding: [20, 20] });
            }
          }
        }, 100);
      } else if (view === 'dashboard') {
        document.getElementById('dashboard-view').style.display = 'block';
        backBtn.style.display = 'block';
        titleEl.textContent = 'ダッシュボード';
        renderDashboard();
      } else if (view === 'navi') {
        document.getElementById('navi-view').style.display = 'block';
        backBtn.style.display = 'block';
        titleEl.textContent = '安全ルート';
        renderNaviView();
      }
      currentView = view;
      window.scrollTo(0, 0);
    };

    function renderDashboard() {
      const loadingEl = document.getElementById('dash-loading');
      if (!dataReady) {
        loadingEl.style.display = 'block';
        return;
      }
      loadingEl.style.display = 'none';

      const summaryEl = document.getElementById('summary');
      const fmsEl = document.getElementById('fms-risk-panel');
      const busEl = document.getElementById('bus-status');

      var summaryHtml = summaryEl.innerHTML.replace(/data-action="filter-by-card"/g, 'data-action="dash-filter"');
      document.getElementById('dash-summary').innerHTML =
        '<div style="margin-bottom:16px"><h3 style="font-size:15px;color:#1a3a5c;margin-bottom:8px">除排雪サマリー</h3>' +
        '<div style="font-size:11px;color:#888;margin-bottom:8px">カードをタップするとマップに遷移します</div>' +
        summaryHtml + '</div>';

      document.getElementById('dash-fms-risk').innerHTML =
        '<div style="margin-bottom:16px"><h3 style="font-size:15px;color:#1a3a5c;margin-bottom:8px">市民報告リスク</h3>' +
        fmsEl.innerHTML + '</div>';

      document.getElementById('dash-bus-status').innerHTML =
        '<div style="margin-bottom:16px"><h3 style="font-size:15px;color:#1a3a5c;margin-bottom:8px">バス運行状況</h3>' +
        busEl.innerHTML + '</div>';
    }

    function renderNaviView() {
      var loadingEl = document.getElementById('navi-loading');
      if (!dataReady) {
        loadingEl.style.display = 'block';
        return;
      }
      loadingEl.style.display = 'none';
      var preserveState = naviSkipReset;
      naviSkipReset = false;
      if (!preserveState) {
        naviOriginArea = null;
        naviDestArea = null;
        naviGpsCoords = null;
        naviTransportMode = null;
        naviRouteCandidates = [];
        naviSelectedRouteIndex = 0;
        pendingRouteResult = null;
      }

      var formHtml = '<div class="navi-form">';
      formHtml += '<label>何を使って移動しますか？</label>';
      formHtml += '<div class="navi-mode-row">';
      formHtml += '<button type="button" id="navi-mode-car" class="navi-mode-btn" data-action="set-navi-mode" data-arg="car">車</button>';
      formHtml += '<button type="button" id="navi-mode-walk-bike" class="navi-mode-btn" data-action="set-navi-mode" data-arg="walk_bike">徒歩・自転車</button>';
      formHtml += '<button type="button" id="navi-mode-bus" class="navi-mode-btn" data-action="set-navi-mode" data-arg="bus">バス</button>';
      formHtml += '</div>';
      formHtml += '<div id="navi-mode-note" class="navi-mode-note">まず交通手段を選択してください。</div>';
      formHtml += '<label>出発地</label>';
      formHtml += '<div id="navi-gps-status" class="navi-gps-status">GPS取得中...</div>';
      formHtml += '<div id="navi-origin-display" class="navi-selection empty">未選択</div>';
      formHtml += '<div class="navi-inline-actions"><button type="button" class="navi-map-pick-btn" data-action="start-navi-pick" data-arg="origin">地図で出発地を選択</button></div>';
      formHtml += '<label>目的地</label>';
      formHtml += '<div id="navi-dest-display" class="navi-selection empty">未選択</div>';
      formHtml += '<div class="navi-inline-actions"><button type="button" class="navi-map-pick-btn" data-action="start-navi-pick" data-arg="dest">地図で目的地を選択</button><button type="button" class="navi-map-pick-btn" data-action="clear-navi-dest">目的地クリア</button></div>';
      formHtml += '<div class="navi-hint">工区番号入力は不要です。地図タップで選択してください。</div>';
      formHtml += '<button class="navi-search-btn" id="navi-search-btn" data-action="search-route" disabled>ルート検索</button>';
      formHtml += '</div>';
      document.getElementById('navi-form-container').innerHTML = formHtml;
      if (!preserveState) {
        document.getElementById('navi-result-container').innerHTML = '';
      }

      if (!preserveState) {
        requestNaviGps();
      } else {
        if (!naviOriginArea) requestNaviGps();
      }
      refreshNaviModeUI();
      refreshNaviSelectionUI();
      updateSearchBtnState();
    }

    function refreshNaviSelectionUI() {
      var originEl = document.getElementById('navi-origin-display');
      var destEl = document.getElementById('navi-dest-display');
      if (originEl) {
        originEl.textContent = naviOriginArea || '未選択';
        originEl.classList.toggle('empty', !naviOriginArea);
      }
      if (destEl) {
        destEl.textContent = naviDestArea || '未選択';
        destEl.classList.toggle('empty', !naviDestArea);
      }
    }

    function refreshNaviModeUI() {
      var modeMap = {
        car: 'navi-mode-car',
        walk_bike: 'navi-mode-walk-bike',
        bus: 'navi-mode-bus',
      };
      Object.keys(modeMap).forEach(function(key) {
        var btn = document.getElementById(modeMap[key]);
        if (btn) btn.classList.toggle('active', naviTransportMode === key);
      });

      var note = document.getElementById('navi-mode-note');
      if (!note) return;
      if (naviTransportMode === 'car') {
        note.textContent = '車向け: スタック情報と除雪リスクを重視します。';
      } else if (naviTransportMode === 'walk_bike') {
        note.textContent = '徒歩・自転車向け: 注意喚起を優先して表示します。';
      } else if (naviTransportMode === 'bus') {
        note.textContent = 'バス向け: 運休・迂回情報と代替案を表示します。';
      } else {
        note.textContent = 'まず交通手段を選択してください。';
      }
    }

    window.setNaviTransportMode = function(mode) {
      naviTransportMode = mode;
      refreshNaviModeUI();
      updateSearchBtnState();
    };

    window.clearNaviDest = function() {
      naviDestArea = null;
      refreshNaviSelectionUI();
      updateSearchBtnState();
    };

    function requestNaviGps() {
      var statusEl = document.getElementById('navi-gps-status');
      if (!navigator.geolocation) {
        statusEl.textContent = 'GPS非対応 - 地図から出発地を選択してください';
        statusEl.className = 'navi-gps-status error';
        refreshNaviSelectionUI();
        return;
      }
      navigator.geolocation.getCurrentPosition(function(pos) {
        naviGpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        var nearest = findNearestArea(naviGpsCoords.lat, naviGpsCoords.lng);
        if (nearest) {
          naviOriginArea = nearest;
          statusEl.textContent = 'GPS取得OK - 最寄りエリア: ' + nearest;
          statusEl.className = 'navi-gps-status ok';
          refreshNaviSelectionUI();
          updateSearchBtnState();
        } else {
          statusEl.textContent = 'エリア特定失敗 - 地図から出発地を選択してください';
          statusEl.className = 'navi-gps-status error';
          refreshNaviSelectionUI();
        }
      }, function() {
        statusEl.textContent = 'GPS取得失敗 - 地図から出発地を選択してください';
        statusEl.className = 'navi-gps-status error';
        refreshNaviSelectionUI();
      }, { timeout: 10000, maximumAge: 60000 });
    }

    function findNearestArea(lat, lng) {
      var minDist = Infinity;
      var nearest = null;
      Object.keys(areasMeta).forEach(function(name) {
        var meta = areasMeta[name];
        if (!meta || !meta.centroid) return;
        var d = haversine(lat, lng, meta.centroid[1], meta.centroid[0]);
        if (d < minDist) { minDist = d; nearest = name; }
      });
      return nearest;
    }

    function haversine(lat1, lng1, lat2, lng2) {
      var R = 6371;
      var dLat = (lat2 - lat1) * Math.PI / 180;
      var dLng = (lng2 - lng1) * Math.PI / 180;
      var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function showNaviPickBanner(text) {
      hideNaviPickBanner();
      var banner = document.createElement('div');
      banner.id = 'navi-pick-banner';
      banner.className = 'navi-pick-banner';
      banner.textContent = text;
      document.body.appendChild(banner);
    }

    function hideNaviPickBanner() {
      var el = document.getElementById('navi-pick-banner');
      if (el) el.remove();
    }

    window.startNaviMapPick = function(mode) {
      naviPickMode = mode;
      naviSkipReset = true;
      showNaviPickBanner(mode === 'origin' ? '地図をタップして出発地を選択してください' : '地図をタップして目的地を選択してください');
      switchView('map');
    };

    function updateSearchBtnState() {
      var btn = document.getElementById('navi-search-btn');
      if (btn) btn.disabled = !(naviTransportMode && naviOriginArea && naviDestArea);
    }

    function computeRiskWeight(areaName) {
      var risk = fmsRisk[areaName];
      if (!risk) return 1;
      var w = 1
        + (risk.stacked || 0) * 5
        + (risk.near_stuck || risk.near_stack || 0) * 3
        + (risk.passable_slow || 0) * 1
        - (risk.resolved || 0) * 0.5
        + (risk.days_since_snow || 0) * 0.5;
      return Math.max(1, w);
    }

    function getCentroidDistanceKm(fromArea, toArea) {
      var fromMeta = areasMeta[fromArea];
      var toMeta = areasMeta[toArea];
      if (!fromMeta || !fromMeta.centroid || !toMeta || !toMeta.centroid) return 1;
      return haversine(fromMeta.centroid[1], fromMeta.centroid[0], toMeta.centroid[1], toMeta.centroid[0]);
    }

    function getModeWeights(profile) {
      var p = profile || 'safe';
      if (naviTransportMode === 'walk_bike') {
        if (p === 'short') return { risk: 0.6, dist: 1.0 };
        if (p === 'balance') return { risk: 0.8, dist: 1.2 };
        return { risk: 1.0, dist: 1.4 };
      }
      if (naviTransportMode === 'bus') {
        if (p === 'short') return { risk: 0.5, dist: 0.9 };
        if (p === 'balance') return { risk: 0.7, dist: 1.0 };
        return { risk: 0.9, dist: 1.1 };
      }
      if (p === 'short') return { risk: 0.6, dist: 1.2 };
      if (p === 'balance') return { risk: 1.0, dist: 1.0 };
      return { risk: 1.4, dist: 0.8 };
    }

    function computeEdgeCost(currentArea, neighborArea, profile, nodePenalty) {
      var baseRisk = computeRiskWeight(neighborArea);
      var distKm = getCentroidDistanceKm(currentArea, neighborArea);
      var w = getModeWeights(profile);
      var cost = baseRisk * w.risk + Math.max(0.4, distKm * 1.4) * w.dist;
      if (naviTransportMode === 'bus') {
        var suspendedNear = findNearestSuspendedStops(neighborArea, 1);
        if (suspendedNear.length > 0 && suspendedNear[0].distanceKm < 1.0) cost += 2.0;
      }
      if (nodePenalty && nodePenalty[neighborArea]) cost += nodePenalty[neighborArea];
      return cost;
    }

    function dijkstra(start, end, options) {
      options = options || {};
      var profile = options.profile || 'safe';
      var nodePenalty = options.nodePenalty || {};
      if (!areasMeta[start] || !areasMeta[end]) return null;
      var dist = {};
      var prev = {};
      var visited = {};
      var queue = [];
      dist[start] = 0;
      queue.push({ node: start, cost: 0 });

      while (queue.length > 0) {
        queue.sort(function(a, b) { return a.cost - b.cost; });
        var current = queue.shift();
        if (visited[current.node]) continue;
        visited[current.node] = true;

        if (current.node === end) break;

        var meta = areasMeta[current.node];
        if (!meta || !meta.neighbors) continue;

        meta.neighbors.forEach(function(neighbor) {
          if (visited[neighbor] || !areasMeta[neighbor]) return;
          var w = computeEdgeCost(current.node, neighbor, profile, nodePenalty);
          var newDist = dist[current.node] + w;
          if (dist[neighbor] === undefined || newDist < dist[neighbor]) {
            dist[neighbor] = newDist;
            prev[neighbor] = current.node;
            queue.push({ node: neighbor, cost: newDist });
          }
        });
      }

      if (dist[end] === undefined) return null;

      var path = [];
      var node = end;
      while (node) {
        path.unshift(node);
        node = prev[node];
      }
      return { path: path, totalCost: dist[end] };
    }

    function routeSignature(path) {
      return (path || []).join('>');
    }

    function generateRouteCandidates(start, end) {
      var candidates = [];
      var profiles = [
        { key: 'safe', label: '安全優先' },
        { key: 'balance', label: 'バランス' },
        { key: 'short', label: '短め' },
      ];
      profiles.forEach(function(p) {
        var r = dijkstra(start, end, { profile: p.key });
        if (r) {
          r.profile = p.key;
          r.profileLabel = p.label;
          candidates.push(r);
        }
      });

      var base = candidates.find(function(c) { return c.profile === 'balance'; }) || candidates[0];
      if (base && base.path && base.path.length > 3) {
        var penalty = {};
        base.path.slice(1, -1).forEach(function(a) { penalty[a] = 2.8; });
        var detour = dijkstra(start, end, { profile: 'balance', nodePenalty: penalty });
        if (detour) {
          detour.profile = 'detour';
          detour.profileLabel = '別案';
          candidates.push(detour);
        }
      }

      var seen = {};
      return candidates.filter(function(c) {
        var sig = routeSignature(c.path);
        if (seen[sig]) return false;
        seen[sig] = true;
        return true;
      }).slice(0, 3);
    }

    function getPathStuckTotal(path) {
      return (path || []).reduce(function(acc, area) {
        var r = fmsRisk[area];
        return acc + (r && typeof r.stuck_total === 'number' ? r.stuck_total : 0);
      }, 0);
    }

    function findNearestSuspendedStops(areaName, limit) {
      limit = limit || 2;
      var meta = areasMeta[areaName];
      if (!meta || !meta.centroid || !busSuspendedData || !busSuspendedData.features) return [];
      var lat = meta.centroid[1];
      var lng = meta.centroid[0];
      var points = [];
      busSuspendedData.features.forEach(function(feature) {
        var p = feature.properties || {};
        var route = p.name || p.id || '運休路線';
        (p.stops || []).forEach(function(stop) {
          if (typeof stop.lat !== 'number' || typeof stop.lng !== 'number') return;
          var d = haversine(lat, lng, stop.lat, stop.lng);
          points.push({ route: route, stop: stop.name || '停留所', distanceKm: d });
        });
      });
      return points.sort(function(a, b) { return a.distanceKm - b.distanceKm; }).slice(0, limit);
    }

    function buildNaviModeInsight(result) {
      var path = (result && result.path) ? result.path : [];
      if (naviTransportMode === 'car') {
        var stuck = getPathStuckTotal(path);
        return '<div class="navi-mode-insight">'
          + '車向け判断: 直近7日スタック関連 <b>' + stuck + '件</b>（経路周辺合計）。'
          + '<br>危険度が高い区間では、迂回・時間変更を検討してください。'
          + '</div>';
      }
      if (naviTransportMode === 'walk_bike') {
        return '<div class="navi-mode-insight">'
          + '徒歩・自転車向け注意: 歩道情報は未整備のため、<b>推奨経路ではなく注意ルート</b>として表示しています。'
          + '<br>交差点、狭い道路、夜間視認性に注意してください。'
          + '</div>';
      }
      if (naviTransportMode === 'bus') {
        var ongoing = (busStatusData && busStatusData.continuing) ? busStatusData.continuing.length : 0;
        var newInfo = (busStatusData && busStatusData.new_info) ? busStatusData.new_info.length : 0;
        var fromStops = findNearestSuspendedStops(naviOriginArea, 2);
        var toStops = findNearestSuspendedStops(naviDestArea, 2);
        var stopText = '';
        if (fromStops.length > 0 || toStops.length > 0) {
          stopText += '<br>最寄り停留所候補: ';
          var all = fromStops.concat(toStops).slice(0, 3).map(function(x) {
            return x.stop + '（' + x.route + '）';
          });
          stopText += all.join(' / ');
        }
        return '<div class="navi-mode-insight">'
          + 'バス向け情報: 運休・迂回継続 <b>' + ongoing + '件</b> / 新着 <b>' + newInfo + '件</b>。'
          + '<br>運休中の場合は、徒歩・車モードの代替ルートも確認してください。'
          + stopText
          + '</div>';
      }
      return '';
    }

    function renderNaviRouteResult() {
      var container = document.getElementById('navi-result-container');
      var result = naviRouteCandidates[naviSelectedRouteIndex];
      if (!container || !result) return;
      pendingRouteResult = result;
      var html = '<div class="navi-result">';
      var modeTitle = naviTransportMode === 'car' ? '車向けルート' : (naviTransportMode === 'walk_bike' ? '徒歩・自転車向け注意ルート' : 'バス向け移動サポート');
      html += '<h3>' + modeTitle + '（' + result.path.length + 'エリア経由）</h3>';
      html += buildNaviModeInsight(result);
      if (naviRouteCandidates.length > 1) {
        html += '<div class="navi-route-options">';
        naviRouteCandidates.forEach(function(c, idx) {
          var active = idx === naviSelectedRouteIndex ? ' active' : '';
          html += '<button type="button" class="navi-route-option-btn' + active + '" data-action="select-navi-route" data-arg="' + idx + '">' + c.profileLabel + '</button>';
        });
        html += '</div>';
      }

      result.path.forEach(function(area, i) {
        var w = computeRiskWeight(area);
        var color = getSegmentColor(w);
        var label = getRiskLabel(w);
        html += '<div class="navi-route-step">';
        html += '<div class="step-dot" style="background:' + color + '"></div>';
        html += '<span>' + (i === 0 ? '出発: ' : i === result.path.length - 1 ? '目的地: ' : '') + escapeHtml(area) + '</span>';
        html += '<span class="step-risk" style="background:' + color + '">' + label + '</span>';
        html += '</div>';
      });

      html += '<div style="margin-top:10px;font-size:12px;color:#888">合計リスクスコア: ' + result.totalCost.toFixed(1) + '</div>';
      html += '<button class="navi-show-map-btn" data-action="show-route-on-map">マップで表示</button>';
      html += '</div>';
      container.innerHTML = html;
    }

    window.selectNaviRoute = function(index) {
      if (index < 0 || index >= naviRouteCandidates.length) return;
      naviSelectedRouteIndex = index;
      renderNaviRouteResult();
    };

    window.searchRoute = function searchRoute() {
      if (!naviTransportMode || !naviOriginArea || !naviDestArea) return;
      var container = document.getElementById('navi-result-container');

      if (naviOriginArea === naviDestArea) {
        container.innerHTML = '<div class="navi-result"><h3>結果</h3><p>出発地と目的地が同じです。</p></div>';
        return;
      }

      var candidates = generateRouteCandidates(naviOriginArea, naviDestArea);
      if (!candidates || candidates.length === 0) {
        container.innerHTML = '<div class="navi-result"><h3>結果</h3><p>ルートが見つかりませんでした。接続されていないエリアの可能性があります。</p></div>';
        return;
      }

      naviRouteCandidates = candidates;
      naviSelectedRouteIndex = 0;
      renderNaviRouteResult();
    };

    function buildRouteLayer(result) {
      if (routeLayer) { map.removeLayer(routeLayer); }
      routeLayer = L.layerGroup();

      var path = result.path;
      for (var i = 0; i < path.length - 1; i++) {
        var fromMeta = areasMeta[path[i]];
        var toMeta = areasMeta[path[i + 1]];
        if (!fromMeta || !fromMeta.centroid || !toMeta || !toMeta.centroid) continue;
        var w = computeRiskWeight(path[i + 1]);
        var color = getSegmentColor(w);
        var line = L.polyline(
          [[fromMeta.centroid[1], fromMeta.centroid[0]], [toMeta.centroid[1], toMeta.centroid[0]]],
          { color: color, weight: 5, opacity: 0.85 }
        );
        routeLayer.addLayer(line);
      }

      // 出発マーカー
      var startMeta = areasMeta[path[0]];
      if (startMeta && startMeta.centroid) {
        var startMarker = L.marker([startMeta.centroid[1], startMeta.centroid[0]], {
          icon: L.divIcon({ className: '', html: '<div style="background:#1a3a5c;color:#fff;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:bold;white-space:nowrap">出発</div>', iconSize: [0, 0], iconAnchor: [-5, 10] })
        });
        routeLayer.addLayer(startMarker);
      }

      // 目的地マーカー
      var endMeta = areasMeta[path[path.length - 1]];
      if (endMeta && endMeta.centroid) {
        var endMarker = L.marker([endMeta.centroid[1], endMeta.centroid[0]], {
          icon: L.divIcon({ className: '', html: '<div style="background:#e74c3c;color:#fff;padding:3px 8px;border-radius:10px;font-size:11px;font-weight:bold;white-space:nowrap">目的地</div>', iconSize: [0, 0], iconAnchor: [-5, 10] })
        });
        routeLayer.addLayer(endMarker);
      }

      routeLayer.addTo(map);
    }

    window.showRouteOnMap = function showRouteOnMap() {
      if (!pendingRouteResult) return;
      buildRouteLayer(pendingRouteResult);

      // fitBounds
      var bounds = [];
      pendingRouteResult.path.forEach(function(area) {
        var meta = areasMeta[area];
        if (meta && meta.centroid) bounds.push([meta.centroid[1], meta.centroid[0]]);
      });
      if (bounds.length > 0) {
        switchView('map');
        setTimeout(function() {
          map.fitBounds(bounds, { padding: [40, 40] });
        }, 200);
      }
    };

    map.on('click', function(e) {
      if (!naviPickMode) return;
      var nearest = findNearestArea(e.latlng.lat, e.latlng.lng);
      if (!nearest) return;
      if (naviPickMode === 'origin') {
        naviOriginArea = nearest;
      } else {
        naviDestArea = nearest;
      }
      naviPickMode = null;
      hideNaviPickBanner();
      naviSkipReset = true;
      switchView('navi');
    });

    function getSegmentColor(weight) {
      if (weight <= 2) return '#27ae60';
      if (weight <= 5) return '#f1c40f';
      if (weight <= 10) return '#e67e22';
      return '#e74c3c';
    }

    function getRiskLabel(weight) {
      if (weight <= 2) return '安全';
      if (weight <= 5) return '注意';
      if (weight <= 10) return '要注意';
      return '危険';
    }

    // スタイル（初期表示は無色、フィルター選択時のみ着色）
    function neutralStyle(feature) {
      const geomType = feature.geometry.type;
      if (geomType === 'Polygon') {
        return { color: '#999', weight: 1, fillColor: '#ddd', fillOpacity: 0.1 };
      }
      return { color: '#bbb', weight: 2, opacity: 0.4 };
    }

    function coloredStyle(feature) {
      const color = getColor(feature.properties['ステータス'] || '');
      const geomType = feature.geometry.type;
      if (geomType === 'Polygon') {
        return { color: '#333', weight: 1.5, fillColor: color, fillOpacity: 0.35 };
      }
      return { color: color, weight: 4, opacity: 0.8 };
    }

    function styleFeature(feature) {
      return coloredStyle(feature);
    }

    function highlightStyle(feature) {
      const color = getColor(feature.properties['ステータス'] || '');
      const geomType = feature.geometry.type;
      if (geomType === 'Polygon') {
        return { color: color, weight: 3, fillColor: color, fillOpacity: 0.5 };
      }
      return { color: color, weight: 6, opacity: 1 };
    }

    // 選択時のパネル表示
    function showDetail(props) {
      const cls = classifyStatus(props['ステータス']);
      const cfg = STATUS_CONFIG[cls];
      const dateText = props['直近作業予定日'] || '未定';
      const dateClass = cls === 'scheduled' ? 'confirmed' : cls === 'checking' ? 'checking' : 'adjusting';

      let html = '<div class="info-card">';
      html += `<div class="area-name">${escapeHtml(props['名前'] || '不明')}</div>`;
      html += `<span class="status-badge" style="background:${cfg.bg}">${cfg.label}</span>`;
      html += `<div class="schedule-date ${dateClass}">${escapeHtml(dateText)}</div>`;
      if (props['指令継続']) {
        html += `<div class="directive-duration"><span class="dur-label">指令継続中</span><span class="dur-value">${escapeHtml(props['指令継続'])}</span></div>`;
      }
      if (props['最終除雪日']) {
        html += `<div class="detail-row"><span class="label">最終除雪日</span><span class="value" style="font-weight:bold;color:#2c3e50">${escapeHtml(props['最終除雪日'])}</span></div>`;
      }
      if (props['指令']) {
        html += `<div class="detail-row"><span class="label">指令</span><span class="value">${escapeHtml(props['指令'])}</span></div>`;
      }
      if (props['更新日時']) {
        html += `<div class="detail-row"><span class="label">更新</span><span class="value">${escapeHtml(props['更新日時'])}</span></div>`;
      }
      if (props['お知らせ']) {
        html += `<div class="detail-row"><span class="label">お知らせ</span><span class="value">${escapeHtml(props['お知らせ'])}</span></div>`;
      }

      // FMSリスク（直近7日間の市民報告）
      const risk = fmsRisk[props['名前']];
      const operatorMoodArea = window.FaceScore ? window.FaceScore.getOperatorMoodForArea(props['名前'], xPostsData) : { available: false };
      if (risk && risk.total > 0) {
        const stuckLabel = risk.stuck_total > 0
          ? `<span style="color:#c0392b;font-weight:bold">⚠ ${risk.stuck_total}件</span>`
          : '<span style="color:#27ae60">0件</span>';
        const periodText = risk.days_since_snow != null ? `除雪${risk.days_since_snow}日前` : '直近7日間';
        const areaFace = window.FaceScore ? window.FaceScore.getAreaFace(risk) : { available: false };
        html += `<div class="detail-row"><span class="label">市民報告(7日)</span><span class="value">${risk.total}件（${periodText}）</span></div>`;
        html += `<div class="detail-row"><span class="label">スタック関連</span><span class="value">${stuckLabel}</span></div>`;
        if (areaFace.available) {
          const confidence = areaFace.confidence === 'low' ? ' / 参考値' : '';
          html += `<div class="detail-row"><span class="label">市民の表情</span><span class="value" style="color:${areaFace.color};font-weight:bold">${areaFace.emoji} ${areaFace.label}（${areaFace.scoreText}${confidence}）</span></div>`;
        }
        if (risk.resolved > 0) {
          html += `<div class="detail-row"><span class="label">改善報告</span><span class="value" style="color:#27ae60">${risk.resolved}件</span></div>`;
        }
      }
      if (operatorMoodArea.available) {
        html += `<div class="detail-row"><span class="label">除雪業者（この工区）</span><span class="value" style="color:${operatorMoodArea.color};font-weight:bold">${operatorMoodArea.emoji} ${operatorMoodArea.label}</span></div>`;
      }

      // スパネ度（泥跳ね指数）
      const spaneZone = spaneData && spaneData.zones && spaneData.zones[props['名前']];
      if (spaneZone) {
        const spaneCol = spaneZone.spane_index >= 70 ? '#795548' : spaneZone.spane_index >= 40 ? '#e67e22' : spaneZone.spane_index >= 15 ? '#f39c12' : '#3498db';
        html += `<div class="detail-row"><span class="label">スパネ度</span><span class="value" style="color:${spaneCol};font-weight:bold">${escapeHtml(String(spaneZone.spane_index))} / 100（${escapeHtml(String(spaneZone.level))}）</span></div>`;
      }

      // 空間情報（メタデータ）
      const meta = areasMeta[props['名前']];
      if (meta) {
        if (meta.address) {
          html += `<div class="detail-row"><span class="label">所在地</span><span class="value" style="font-size:11px">${escapeHtml(meta.address)}</span></div>`;
        }
        if (meta.neighbors && meta.neighbors.length > 0) {
          const shown = meta.neighbors.slice(0, 6);
          const more = meta.neighbors.length > 6 ? ` 他${meta.neighbors.length - 6}件` : '';
          html += `<div class="detail-row"><span class="label">隣接</span><span class="value" style="font-size:11px">${shown.map(escapeHtml).join(', ')}${more}</span></div>`;
        }
      }

      html += '</div>';

      // 共有ボタン
      const nameForShare = (props['名前'] || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
      html += `<button class="share-btn" data-area="${nameForShare}" data-action="share-area">𝕏 Xで共有</button>`;

      // 路面状況予測カード（折りたたみ）
      const pred = roadPredictions[props['名前']];
      if (pred && window.RoadSVG) {
        const safeId = 'road-card-' + (props['名前'] || '').replace(/[^\w]/g, '_');
        html += `<div style="margin-top:10px">`;
        html += `<div data-action="toggle-block" data-target="${safeId}" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:#eef3f8;border-radius:6px;font-size:12px;font-weight:bold;color:#555;margin-bottom:4px">`;
        html += `<span>🚗 ドライバー視点（概念図）</span><span class="ti">▶</span>`;
        html += `</div>`;
        html += `<div id="${safeId}" style="display:none">`;
        html += window.RoadSVG.renderRoadConditionCard(pred);
        html += `</div></div>`;
      }

      document.getElementById('selected-info').innerHTML = html;
      showXPosts(props['名前']);

      // パネルを詳細カードの位置までスクロール
      document.getElementById('selected-info').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // 投稿をスタック危険度で分類
    const RISK_TAGS = [
      { key: 'stacked',       label: 'スタック・立往生', color: '#c0392b', re: /スタック|立ち往生|動け|はまっ|埋ま|出せな|出られ/ },
      { key: 'near_stack',    label: '走行注意',         color: '#e67e22', re: /空転|わだち|腹.*つ[かけ]|ガタガタ|バンパー|亀裂|段差|ひどい|やばい|ヤバ|デスロード/ },
      { key: 'passable_slow', label: '通行しづらい',     color: '#f39c12', re: /すれ違|狭|通れ|歩道|通学|歩け|歩行|1車線|一車線/ },
      { key: 'resolved',      label: '改善',             color: '#27ae60', re: /きれい|感謝|ありがと|解消|入りました|除雪.*入っ|アスファルト.*見え/ },
    ];

    function classifyRisk(text) {
      const t = text || '';
      for (const tag of RISK_TAGS) {
        if (tag.re.test(t)) return tag.key;
      }
      return 'info';
    }

    function countRisks(posts) {
      const counts = {};
      RISK_TAGS.forEach(t => { counts[t.key] = 0; });
      counts['info'] = 0;
      posts.forEach(p => { counts[classifyRisk(p.text)]++; });
      return counts;
    }

    function renderRiskBars(counts, total, fontSize) {
      let html = '';
      RISK_TAGS.forEach(tag => {
        const c = counts[tag.key] || 0;
        if (c === 0) return;
        const pct = Math.round(c / total * 100);
        const barW = Math.max(pct, 5);
        html += `<div style="margin-bottom:3px;font-size:${fontSize}px">`;
        html += `<span style="display:inline-block;width:90px">${tag.label}</span>`;
        html += `<span style="display:inline-block;width:${barW}%;max-width:55%;height:${fontSize - 1}px;background:${tag.color};border-radius:2px;vertical-align:middle;margin-right:4px"></span>`;
        html += `<span style="color:#888">${c}件</span>`;
        html += `</div>`;
      });
      const info = counts['info'] || 0;
      if (info > 0) {
        html += `<div style="margin-bottom:3px;font-size:${fontSize}px">`;
        html += `<span style="display:inline-block;width:90px;color:#999">その他</span>`;
        html += `<span style="color:#aaa">${info}件</span>`;
        html += `</div>`;
      }
      return html;
    }

    // 工区クリック時：周辺の危険度集計表示
    function showXPosts(areaName) {
      const container = document.getElementById('x-posts-container');
      if (!areaName || xPostsData.length === 0) {
        container.innerHTML = '';
        return;
      }

      const meta = areasMeta[areaName];
      const relatedAreas = new Set([areaName]);
      if (meta && meta.neighbors) {
        meta.neighbors.forEach(n => relatedAreas.add(n));
      }

      const posts = xPostsData.filter(p => relatedAreas.has(p.area));
      if (posts.length === 0) {
        container.innerHTML = '';
        return;
      }

      const counts = countRisks(posts);
      const stuckTotal = (counts.stacked || 0) + (counts.near_stack || 0);

      let html = '<div class="x-posts-section">';
      html += `<h4>周辺の通行リスク（${posts.length}件を集計）</h4>`;
      if (stuckTotal > 0) {
        html += `<div style="font-size:13px;font-weight:bold;color:#c0392b;margin-bottom:6px">⚠ スタック関連: ${stuckTotal}件</div>`;
      }
      html += renderRiskBars(counts, posts.length, 12);
      html += '<div style="font-size:10px;color:#aaa;margin-top:4px">※SNS投稿の統計。原文非公開。</div>';
      html += '</div>';
      container.innerHTML = html;
    }


    // フィーチャークリック
    function onFeatureClick(e) {
      const layer = e.target;
      const feature = layer.feature;

      // 前の選択をリセット
      if (selectedLayer && selectedLayer !== layer) {
        selectedLayer.setStyle(neutralStyle(selectedLayer.feature));
      }
      selectedLayer = layer;
      layer.setStyle(highlightStyle(feature));
      showDetail(feature.properties);

      // マップ上にポップアップで工区情報を表示
      const props = feature.properties;
      const cls = classifyStatus(props['ステータス']);
      const cfg = STATUS_CONFIG[cls];
      const dateText = props['直近作業予定日'] || '未定';
      let popupHtml = `<div style="min-width:160px">`;
      popupHtml += `<div style="font-size:13px;font-weight:bold;color:#1a3a5c;margin-bottom:4px">${escapeHtml(props['名前'] || '不明')}</div>`;
      popupHtml += `<div style="margin-bottom:4px"><span style="background:${cfg.bg};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold">${cfg.label}</span></div>`;
      popupHtml += `<div style="font-size:12px">予定日: ${escapeHtml(dateText)}</div>`;
      popupHtml += `</div>`;
      L.popup().setLatLng(e.latlng).setContent(popupHtml).openOn(map);
    }

    // エリアリストはサマリーカードクリックで動的生成（filterByCard内）

    // エリアリストからの選択
    window.selectArea = function(globalIndex) {
      const item = allLayers[globalIndex];
      if (!item) return;
      const { layer, feature } = item;

      if (selectedLayer && selectedLayer !== layer) {
        selectedLayer.setStyle(neutralStyle(selectedLayer.feature));
      }
      selectedLayer = layer;
      layer.setStyle(highlightStyle(feature));
      showDetail(feature.properties);

      // 地図をパン
      if (layer.getBounds) {
        map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 15 });
      } else if (layer.getLatLng) {
        map.setView(layer.getLatLng(), 15);
      }
    };

    // 工区名から地図選択
    window.selectAreaByName = function(name) {
      const item = allLayers.find(l => l.feature.properties['名前'] === name);
      if (!item) return;
      const { layer, feature } = item;
      if (selectedLayer && selectedLayer !== layer) {
        selectedLayer.setStyle(neutralStyle(selectedLayer.feature));
      }
      selectedLayer = layer;
      layer.setStyle(highlightStyle(feature));
      showDetail(feature.properties);
      if (layer.getBounds) {
        map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 15 });
      }
      // URLバーを更新
      const url = new URL(window.location);
      url.searchParams.set('area', name);
      history.replaceState(null, '', url);
    };

    // Xで共有
    // ヘッダーナビメニュー
    window.toggleNavMenu = function(e) {
      e.stopPropagation();
      var menu = document.getElementById('nav-menu');
      // 現在のビューをハイライト
      menu.querySelectorAll('a').forEach(function(a) { a.classList.remove('nav-active'); });
      var viewMap = {'hub':0,'map':1,'navi':2,'dashboard':3};
      var idx = viewMap[currentView];
      if (idx !== undefined) menu.querySelectorAll('a')[idx].classList.add('nav-active');
      menu.classList.toggle('open');
      document.getElementById('share-menu').classList.remove('open');
    };
    window.navTo = function(view, e) {
      e.preventDefault();
      document.getElementById('nav-menu').classList.remove('open');
      switchView(view);
    };
    // サイト共有メニュー
    window.toggleShareMenu = function(e) {
      e.stopPropagation();
      document.getElementById('nav-menu').classList.remove('open');
      var menu = document.getElementById('share-menu');
      menu.classList.toggle('open');
    };

    // メニューを閉じる（ナビ・共有共通）
    document.addEventListener('click', function(e) {
      if (e.target && e.target.closest && e.target.closest('[data-action="toggle-nav-menu"],[data-action="toggle-share-menu"]')) return;
      document.getElementById('nav-menu').classList.remove('open');
      document.getElementById('share-menu').classList.remove('open');
    });

    window.shareTo = function(platform, e) {
      e.preventDefault();
      document.getElementById('share-menu').classList.remove('open');
      var url = 'https://aomori-snow-tracker.web.app/';
      var text = '青森除雪ウォッチ — 青森市の除排雪スケジュールをリアルタイムで地図表示 #青森市 #除雪';
      switch (platform) {
        case 'x':
          window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text + '\n' + url), '_blank', 'noopener');
          break;
        case 'fb':
          window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url), '_blank', 'noopener');
          break;
        case 'line':
          window.open('https://social-plugins.line.me/lineit/share?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text), '_blank', 'noopener');
          break;
        case 'copy':
          navigator.clipboard.writeText(url).then(function() {
            alert('URLをコピーしました');
          });
          break;
      }
    };

    // エリア個別のX共有
    window.shareArea = function(name) {
      const item = allLayers.find(l => l.feature.properties['名前'] === name);
      if (!item) return;
      const props = item.feature.properties;
      const status = props['ステータス'] || '不明';
      const date = props['直近作業予定日'] || '未定';
      const risk = fmsRisk[name];
      const stuckCount = risk ? risk.stuck_total : 0;

      const deepLink = new URL(window.location);
      deepLink.searchParams.set('area', name);

      const text = `【${name}】${status}（${date}）\nスタック関連: ${stuckCount}件\n#青森除雪ウォッチ #青森市\n${deepLink.href}`;
      const intentUrl = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(text);
      window.open(intentUrl, '_blank', 'noopener');
    };

    // サマリー表示（工区・路線別、母数付き、クリックでフィルター＋一覧表示）
    let kokuFeaturesGlobal = [];
    let rosenFeaturesGlobal = [];

    function buildSummary(kokuFeatures, rosenFeatures) {
      kokuFeaturesGlobal = kokuFeatures;
      rosenFeaturesGlobal = rosenFeatures;

      function countByStatus(features) {
        const c = { scheduled: 0, checking: 0, adjusting: 0, other: 0 };
        features.forEach(f => {
          const cls = classifyStatus(f.properties['ステータス']);
          c[cls] = (c[cls] || 0) + 1;
        });
        return c;
      }

      // 路線は同名セグメントを重複排除してから集計
      const rosenUniq = [...new Map(rosenFeatures.map(f => [f.properties['名前'], f])).values()];

      const koku = countByStatus(kokuFeatures);
      const rosen = countByStatus(rosenUniq);
      const kTotal = kokuFeatures.length;
      const rTotal = rosenUniq.length;

      function diffBadge(current, prev) {
        if (prev == null) return '';
        const d = current - prev;
        if (d === 0) return '<span style="font-size:10px;color:#999;margin-left:2px">±0</span>';
        const color = d > 0 ? '#e74c3c' : '#27ae60';
        const arrow = d > 0 ? '↑' : '↓';
        return `<span style="font-size:10px;color:${color};margin-left:2px">${arrow}${Math.abs(d)}</span>`;
      }

      function summaryRow(type, label, counts, total) {
        const otherCount = total - counts.scheduled - counts.checking - counts.adjusting;
        const prev = prevSummary ? prevSummary[type] : null;
        const prevDate = prevSummary ? prevSummary.date : '';
        const prevLabel = prevDate ? prevDate.slice(5).replace('-', '/') : '';

        let html = `<div class="summary-section-title">${label}（全${total}）</div>`;
        html += '<div class="summary-grid">';

        const items = [
          ['scheduled', '作業予定あり', counts.scheduled],
          ['checking', '現場確認中', counts.checking],
          ['adjusting', '日程調整中', counts.adjusting],
        ];

        items.forEach(([key, name, val]) => {
          const prevVal = prev ? prev[key] : null;
          const diff = diffBadge(val, prevVal);
          const prevLine = prev != null ? `<div style="font-size:9px;color:#aaa;margin-top:1px">前日 ${prev[key]}/${prev.total}</div>` : '';
          html += `<div class="summary-item" data-action="filter-by-card" data-type="${type}" data-key="${key}">`;
          html += `<div class="count count-${key}">${val}<span class="total">/${total}</span>${diff}</div>`;
          html += `<div class="label">${name}</div>`;
          html += prevLine;
          html += `</div>`;
        });

        html += '</div>';
        if (otherCount > 0) {
          html += `<div style="font-size:11px;color:#999;text-align:right;margin-top:-4px;margin-bottom:8px;cursor:pointer" data-action="filter-by-card" data-type="${type}" data-key="other">その他: ${otherCount} ▶</div>`;
        }
        return html;
      }

      // 応援除雪集計（期間日付で判定）
      const _now = new Date(); _now.setHours(0, 0, 0, 0);
      const supportSeen = new Set();
      let supportActive = [], supportUpcoming = [];
      supportZones.forEach(f => {
        const p = f.properties;
        const name = p['工区名'] || p['名前'] || '';
        const period = p['作業予定期間（開始予定日～終了予定日）'] || '';
        if (!period.trim() || supportSeen.has(name)) return;
        supportSeen.add(name);
        const [s, e] = parsePeriodDates(period);
        if (!s || !e) return;
        const meta = areasMeta[name] || {};
        const quarter = (meta.address_detail && meta.address_detail.quarter) || '';
        const label = quarter || name;
        if (s <= _now && _now <= e) supportActive.push({ name, label, end: e });
        else if (s > _now) supportUpcoming.push({ name, label, start: s, end: e });
      });

      let supportHtml = '';
      if (supportActive.length > 0 || supportUpcoming.length > 0) {
        supportHtml += `<div class="summary-section-title">県応援除雪</div>`;
        if (supportActive.length > 0) {
          supportHtml += `<div style="font-size:11px;font-weight:bold;color:#2e7d32;margin:4px 0 2px">現在作業中 ${supportActive.length}工区</div>`;
          supportActive.forEach(({label, end}) => {
            const mm = end.getMonth()+1, dd = end.getDate();
            supportHtml += `<div style="font-size:11px;color:#444;padding:1px 4px">▸ ${escapeHtml(label)}（〜${mm}/${dd}）</div>`;
          });
        }
        if (supportUpcoming.length > 0) {
          supportHtml += `<div style="font-size:11px;font-weight:bold;color:#f57f17;margin:6px 0 2px">今後予定 ${supportUpcoming.length}工区</div>`;
          supportUpcoming.forEach(({label, start, end}) => {
            const sm = start.getMonth()+1, sd = start.getDate();
            const em = end.getMonth()+1, ed = end.getDate();
            supportHtml += `<div style="font-size:11px;color:#444;padding:1px 4px">▸ ${escapeHtml(label)}（${sm}/${sd}〜${em}/${ed}）</div>`;
          });
        }
      }

      document.getElementById('summary').innerHTML =
        summaryRow('koku', '工区', koku, kTotal) + summaryRow('rosen', '路線', rosen, rTotal) + supportHtml;

      // シェア用に件数を保存
      window._summaryStats = { koku, rosen, kTotal, rTotal, supportActive, supportUpcoming };
      document.getElementById('share-bar').style.display = '';
    }

    // カードクリックでフィルター＋一覧表示
    let activeCardType = null;
    let activeCardStatus = null;

    window.filterByCard = function(type, status) {
      // 同じカードを再クリックで閉じる
      if (activeCardType === type && activeCardStatus === status) {
        activeCardType = null;
        activeCardStatus = null;
        document.getElementById('area-list-section').style.display = 'none';
        // 全レイヤーを無色に戻す
        allLayers.forEach(({ layer, feature }) => {
          layer.setStyle(neutralStyle(feature));
        });
        // active解除
        document.querySelectorAll('.summary-item.active').forEach(el => el.classList.remove('active'));
        // 応援除雪レイヤーを復帰
        if (layerVisibility.support && !map.hasLayer(supportLayer)) {
          supportLayer.addTo(map);
        }
        return;
      }

      activeCardType = type;
      activeCardStatus = status;

      // active表示更新
      document.querySelectorAll('.summary-item.active').forEach(el => el.classList.remove('active'));
      event.currentTarget.classList.add('active');

      // 対象フィーチャー取得
      const features = type === 'koku' ? kokuFeaturesGlobal : rosenFeaturesGlobal;
      const filtered = features.filter(f => classifyStatus(f.properties['ステータス']) === status);
      const typeName = type === 'koku' ? '工区' : '路線';
      const statusName = STATUS_CONFIG[status]?.label || 'その他';

      // 一覧タイトル更新
      document.getElementById('area-list-title').textContent = `${typeName} - ${statusName}（${filtered.length}件）`;
      document.getElementById('area-list-section').style.display = 'block';
      document.getElementById('area-list-body').style.display = 'block';
      document.getElementById('area-list-toggle').textContent = '▲ 閉じる';

      // 一覧構築（路線は同名セグメントを重複排除して1路線1行）
      filtered.sort((a, b) => (a.properties['名前'] || '').localeCompare(b.properties['名前'] || '', 'ja'));
      const seenNames = new Set();
      const deduped = type === 'rosen'
        ? filtered.filter(f => { const n = f.properties['名前']; if (seenNames.has(n)) return false; seenNames.add(n); return true; })
        : filtered;
      const listEl = document.getElementById('area-list');
      if (type === 'rosen') {
        document.getElementById('area-list-title').textContent = `路線 - ${statusName}（${deduped.length}路線）`;
      }
      listEl.innerHTML = deduped.map(f => {
        const p = f.properties;
        const cls = classifyStatus(p['ステータス']);
        const cfg = STATUS_CONFIG[cls];
        const date = escapeHtml(p['直近作業予定日'] || '-');
        const lastSnow = escapeHtml(p['最終除雪日'] || '-');
        const duration = escapeHtml(p['指令継続'] || '');
        return `<div class="area-item" data-action="select-area" data-arg="${f._globalIndex}">
          <div>
            <span class="name">${escapeHtml(p['名前'])}</span>
            <div style="font-size:11px;color:#999;margin-top:2px">前回: ${lastSnow}${duration ? ' / 指令: ' + duration : ''}</div>
          </div>
          <span class="date" style="color:${cfg.color}">${date}</span>
        </div>`;
      }).join('');

      // 一覧位置にスクロール
      document.getElementById('area-list-section').scrollIntoView({ behavior: 'smooth', block: 'start' });

      // 地図上の表示を絞る（対象だけ着色、他は薄く）
      const filteredSet = new Set(filtered.map(f => f._globalIndex));
      allLayers.forEach(({ layer, feature }) => {
        if (filteredSet.has(feature._globalIndex)) {
          layer.setStyle(coloredStyle(feature));
        } else {
          layer.setStyle({ color: '#ccc', weight: 0.5, opacity: 0.15, fillOpacity: 0.03 });
        }
      });

      // 応援除雪レイヤーを非表示（工区フィルター中は邪魔になる）
      if (map.hasLayer(supportLayer)) {
        map.removeLayer(supportLayer);
      }
    };

    window.toggleAreaList = function() {
      const body = document.getElementById('area-list-body');
      const toggle = document.getElementById('area-list-toggle');
      if (body.style.display === 'none') {
        body.style.display = 'block';
        toggle.textContent = '▲ 閉じる';
      } else {
        body.style.display = 'none';
        toggle.textContent = '▼ 開く';
      }
    };

    // X でシェア
    window.shareToX = function() {
      const s = window._summaryStats;
      if (!s) return;
      const d = new Date();
      const mm = d.getMonth() + 1, dd = d.getDate();
      let text = `【青森市 除雪出動指令状況】${mm}/${dd} 更新\n`;
      text += `工区（${s.kTotal}）: 作業予定あり ${s.koku.scheduled}件`;
      if (s.koku.adjusting > 0) text += ` / 日程調整中 ${s.koku.adjusting}件`;
      text += `\n路線（${s.rTotal}）: 作業予定あり ${s.rosen.scheduled}路線`;
      if (s.rosen.adjusting > 0) text += ` / 日程調整中 ${s.rosen.adjusting}路線`;
      if (s.supportActive && s.supportActive.length > 0) {
        text += `\n県応援除雪: ${s.supportActive.length}工区 作業中`;
        if (s.supportActive.length <= 3) {
          text += `（${s.supportActive.map(z => z.label).join('・')}）`;
        }
      }
      text += `\n#青森市道路雪情報 #除雪`;
      const url = 'https://aomori-snow-tracker.web.app';
      window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank');
    };

    // 全体表示に戻す
    window.resetView = function() {
      if (activePurposeKey === 'learning') {
        applyLayerPreset(purposeConfigs.learning.layers);
        document.getElementById('selected-info').innerHTML = '';
        document.getElementById('x-posts-container').innerHTML = '';
        map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        document.getElementById('panel-content').scrollTop = 0;
        return;
      }
      // フィルター解除
      activeCardType = null;
      activeCardStatus = null;
      document.querySelectorAll('.summary-item.active').forEach(el => el.classList.remove('active'));
      document.getElementById('area-list-section').style.display = 'none';

      // バスレイヤー非表示
      if (layerVisibility.bus) {
        layerVisibility.bus = false;
        map.removeLayer(busLayer);
        busLayersVisible = false;
        const btn = document.getElementById('bus-map-toggle');
        if (btn) { btn.textContent = '🗺 地図に表示'; btn.style.background = '#f59e0b'; }
        updateToggleCheckbox('bus');
      }

      // 他レイヤーを表示状態に復帰
      ['koku', 'dump', 'ryusetsuko', 'kokudo', 'support'].forEach(key => {
        if (!layerVisibility[key]) {
          layerVisibility[key] = true;
          layerGroupMap[key].addTo(map);
          updateToggleCheckbox(key);
        }
      });

      // 選択解除
      if (selectedLayer) {
        selectedLayer.setStyle(neutralStyle(selectedLayer.feature));
        selectedLayer = null;
      }
      document.getElementById('selected-info').innerHTML = '';
      document.getElementById('x-posts-container').innerHTML = '';

      // 全レイヤーを無色に戻す
      allLayers.forEach(({ layer, feature }) => {
        layer.setStyle(neutralStyle(feature));
      });

      // 地図を市街地表示（浪岡を除く）
      map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);

      // パネル先頭にスクロール
      document.getElementById('panel-content').scrollTop = 0;
    };

    // 凡例
    const legend = L.control({ position: 'topleft' });
    var legendDiv = null;
    legend.onAdd = function() {
      legendDiv = L.DomUtil.create('div', 'legend');
      L.DomEvent.disableClickPropagation(legendDiv);
      updateLegend();
      return legendDiv;
    };
    function updateLegend() {
      if (!legendDiv) return;
      var html = '';

      // ── 除雪グループ ──
      const hasJosetsu = layerVisibility.koku || layerVisibility.support || layerVisibility.kokudo;
      if (hasJosetsu) {
        html += '<div class="legend-section">除雪</div>';
        // 市（工区・路線）
        if (layerVisibility.koku) {
          html += '<div style="font-size:9px;color:#888;margin:2px 0 1px;padding-left:2px">市（工区・路線）</div>';
          if (kokuStatusVisibility.scheduled) html += '<div class="legend-item"><span class="legend-color" style="background:#e74c3c"></span>作業予定あり</div>';
          if (kokuStatusVisibility.checking) html += '<div class="legend-item"><span class="legend-color" style="background:#3498db"></span>現場確認中</div>';
          if (kokuStatusVisibility.adjusting) html += '<div class="legend-item"><span class="legend-color" style="background:#e67e22"></span>日程調整中</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#95a5a6"></span>その他</div>';
        }
        // 県（応援除雪）
        if (layerVisibility.support) {
          html += '<div style="font-size:9px;color:#888;margin:4px 0 1px;padding-left:2px">県（応援除雪）</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#2e7d32"></span>作業中</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#f57f17"></span>今後予定</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#78909c"></span>作業終了</div>';
        }
        // 国（国道）
        if (layerVisibility.kokudo) {
          html += '<div style="font-size:9px;color:#888;margin:4px 0 1px;padding-left:2px">国（国道）</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#f1c40f"></span>作業中</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#16a085"></span>除雪済</div>';
        }
      }

      // ── その他グループ ──
      const hasOther = layerVisibility.dump || layerVisibility.ryusetsuko || layerVisibility.bus || layerVisibility.spane;
      if (hasOther) {
        html += '<div class="legend-section">その他</div>';
        if (layerVisibility.dump) {
          html += '<div class="legend-item"><span style="background:#2ecc71;color:#fff;width:10px;height:10px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:7px;flex-shrink:0">&#10052;</span> 雪捨て場</div>';
        }
        if (layerVisibility.ryusetsuko) {
          html += '<div class="legend-item" style="margin-top:2px"><span style="font-size:9px;color:#888">流雪溝</span></div>';
          html += '<div class="legend-item"><span style="background:#3498db;width:10px;height:10px;border-radius:50%;flex-shrink:0"></span> ポンプ場</div>';
          html += '<div class="legend-item"><span style="background:#e67e22;width:10px;height:10px;border-radius:50%;flex-shrink:0"></span> 排水</div>';
          html += '<div class="legend-item"><span style="background:#9b59b6;width:10px;height:10px;border-radius:50%;flex-shrink:0"></span> 取水</div>';
        }
        if (layerVisibility.bus) {
          html += '<div class="legend-item"><span class="legend-color" style="background:#dc2626"></span>バス運休</div>';
        }
        if (layerVisibility.spane) {
          html += '<div class="legend-item" style="margin-top:2px"><span style="font-size:9px;color:#888">スパネ度（泥跳ね）</span></div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#3498db"></span>低 (0〜14)</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#f39c12"></span>中 (15〜39)</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#e67e22"></span>高 (40〜69)</div>';
          html += '<div class="legend-item"><span class="legend-color" style="background:#795548"></span>危 (70〜)</div>';
        }
      }
      if (layerVisibility.kids_admin || layerVisibility.kids_private) {
        html += '<div class="legend-section">子育て学び</div>';
        if (layerVisibility.kids_admin) {
          html += '<div class="legend-item"><span style="background:#be185d;color:#fff;width:10px;height:10px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:7px;flex-shrink:0">★</span> 行政</div>';
        }
        if (layerVisibility.kids_private) {
          html += '<div class="legend-item"><span style="background:#0284c7;color:#fff;width:10px;height:10px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:7px;flex-shrink:0">★</span> 民間一般</div>';
        }
      }

      legendDiv.innerHTML = html || '<span style="color:#aaa">凡例なし</span>';
    }
    legend.addTo(map);

    // スパネ度コントロール（右下）
    var spaneDiv = null;
    const spaneControl = L.control({ position: 'bottomright' });
    spaneControl.onAdd = function() {
      spaneDiv = L.DomUtil.create('div', 'spane-panel');
      L.DomEvent.disableClickPropagation(spaneDiv);
      spaneDiv.style.display = 'none';
      return spaneDiv;
    };
    spaneControl.addTo(map);

    // レイヤーコントロール（パネル内に配置）
    function renderPanelLayerControl() {
      const container = document.getElementById('panel-layer-control');
      if (!container) return;

      let html = '<div class="layer-control" style="box-shadow:none;margin-bottom:10px">';
      html += '<div class="layer-control-header" id="panel-lc-header">';
      html += '🗂 レイヤー <span style="font-size:10px">▼</span></div>';
      html += '<div class="layer-control-body" id="panel-lc-body">';

      const layerGroups = activePurposeKey === 'learning'
        ? [
            {
              label: '子育て学び',
              items: [
                { key: 'kids_admin', label: '子育てイベント（行政）', icon: '<span style="background:#be185d;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px">★</span>' },
                { key: 'kids_private', label: '子育てイベント（民間一般）', icon: '<span style="background:#0284c7;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px">★</span>' },
              ]
            },
          ]
        : [
            {
              label: '安全',
              items: [
                { key: 'koku',    label: '工区・路線除雪（市）', icon: '<span style="display:inline-block;width:14px;height:14px;background:#e74c3c;opacity:0.5;border:1px solid #e74c3c;border-radius:2px"></span>' },
                { key: 'support', label: '応援除雪（県）',       icon: '<span style="display:inline-block;width:14px;height:14px;background:#2e7d32;opacity:0.5;border:1px solid #2e7d32;border-radius:2px"></span>' },
                { key: 'kokudo',  label: '国道除雪（国）',       icon: '<span style="display:inline-block;width:14px;height:4px;background:#f1c40f;border-radius:2px"></span>' },
                { key: 'dump',       label: '雪捨て場',         icon: '<span style="background:#2ecc71;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px">&#10052;</span>' },
                { key: 'ryusetsuko', label: '流雪溝施設',       icon: '<span style="background:#3498db;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:8px">💧</span>' },
                { key: 'spane',      label: 'スパネ度（泥跳ね）', icon: '<span style="display:inline-block;width:14px;height:14px;background:#f39c12;opacity:0.8;border:1px solid #e67e22;border-radius:2px"></span>' },
              ]
            },
            {
              label: '移動',
              items: [
                { key: 'bus', label: 'バス運休区間', icon: '<span style="display:inline-block;width:14px;height:4px;background:#dc2626;border-radius:2px"></span>' },
              ]
            },
            {
              label: '子育て学び',
              items: [
                { key: 'kids_admin', label: '子育てイベント（行政）', icon: '<span style="background:#be185d;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px">★</span>' },
                { key: 'kids_private', label: '子育てイベント（民間一般）', icon: '<span style="background:#0284c7;color:#fff;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px">★</span>' },
              ]
            },
          ];

      layerGroups.forEach(function({ label: groupLabel, items }) {
        html += `<div style="font-size:10px;font-weight:bold;color:#888;margin:6px 0 2px;padding-left:2px;border-bottom:1px solid #eee">${groupLabel}</div>`;
        items.forEach(function({ key, label, icon }) {
          const checked = layerVisibility[key] ? 'checked' : '';
          html += '<div class="layer-control-item">';
          html += '<input type="checkbox" id="layer-cb-' + key + '" ' + checked + ' data-action-change="toggle-layer" data-arg="' + key + '">';
          html += '<label for="layer-cb-' + key + '">' + icon + ' ' + label + '</label>';
          html += '</div>';
          if (key === 'koku') {
            const statuses = [
              { key: 'scheduled', label: '作業予定あり', color: '#e74c3c' },
              { key: 'checking', label: '現場確認中', color: '#3498db' },
              { key: 'adjusting', label: '日程調整中', color: '#e67e22' },
            ];
            statuses.forEach(function(st) {
              const subChecked = kokuStatusVisibility[st.key] ? 'checked' : '';
              const disabled = layerVisibility.koku ? '' : 'disabled';
              const disabledClass = layerVisibility.koku ? '' : ' disabled';
              html += '<div class="layer-control-subitem' + disabledClass + '" id="layer-sub-wrap-' + st.key + '">';
              html += '<input type="checkbox" id="layer-cb-koku-' + st.key + '" ' + subChecked + ' ' + disabled + ' data-action-change="toggle-koku-status" data-arg="' + st.key + '">';
              html += '<label for="layer-cb-koku-' + st.key + '"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + st.color + '"></span>' + st.label + '</label>';
              html += '</div>';
            });
          }
        });
      });

      html += '</div></div>';
      container.innerHTML = html;

      document.getElementById('panel-lc-header').addEventListener('click', function() {
        const body = document.getElementById('panel-lc-body');
        const header = document.getElementById('panel-lc-header');
        body.classList.toggle('hidden');
        header.classList.toggle('collapsed');
        header.querySelector('span').textContent = body.classList.contains('hidden') ? '▶' : '▼';
      });
    }
    renderPanelLayerControl();

    function shouldShowKokuByStatus(statusClass) {
      if (statusClass === 'scheduled' || statusClass === 'checking' || statusClass === 'adjusting') {
        return kokuStatusVisibility[statusClass];
      }
      return true;
    }

    function applyKokuStatusFilter() {
      allLayers.forEach(function(item) {
        if (!item || item.source !== 'koku') return;
        const visible = shouldShowKokuByStatus(item.statusClass);
        if (visible) {
          if (!kokuLayer.hasLayer(item.layer)) kokuLayer.addLayer(item.layer);
          if (item.labelLayer && !kokuLayer.hasLayer(item.labelLayer)) kokuLayer.addLayer(item.labelLayer);
        } else {
          if (kokuLayer.hasLayer(item.layer)) kokuLayer.removeLayer(item.layer);
          if (item.labelLayer && kokuLayer.hasLayer(item.labelLayer)) kokuLayer.removeLayer(item.labelLayer);
        }
      });

      if (selectedLayer && selectedLayer.feature && selectedLayer.feature._source === 'koku') {
        const selectedItem = allLayers.find(function(item) { return item.layer === selectedLayer; });
        if (selectedItem && !shouldShowKokuByStatus(selectedItem.statusClass)) {
          selectedLayer = null;
          map.closePopup();
        }
      }
    }

    function updateKokuSubControls() {
      ['scheduled', 'checking', 'adjusting'].forEach(function(key) {
        const cb = document.getElementById('layer-cb-koku-' + key);
        const wrap = document.getElementById('layer-sub-wrap-' + key);
        if (cb) {
          cb.checked = kokuStatusVisibility[key];
          cb.disabled = !layerVisibility.koku;
        }
        if (wrap) {
          wrap.classList.toggle('disabled', !layerVisibility.koku);
        }
      });
    }

    window.toggleKokuStatus = function(key) {
      kokuStatusVisibility[key] = !kokuStatusVisibility[key];
      applyKokuStatusFilter();
      updateKokuSubControls();
      updateLegend();
    };

    // レイヤートグル関数
    window.toggleLayer = function(key) {
      layerVisibility[key] = !layerVisibility[key];
      const group = layerGroupMap[key];
      if (layerVisibility[key]) {
        group.addTo(map);
      } else {
        map.removeLayer(group);
      }
      // チェックボックス・凡例を同期
      updateToggleCheckbox(key);
      updateLegend();
      // スパネ度の場合はレイヤーを描画（ON時のみ）
      if (key === 'spane') {
        renderSpaneLayer();
        renderSpanePanel();
      }
      // バスの場合はパネルボタンも同期
      if (key === 'bus') {
        busLayersVisible = layerVisibility.bus;
        const btn = document.getElementById('bus-map-toggle');
        if (btn) {
          if (busLayersVisible) {
            btn.textContent = '🗺 地図から非表示';
            btn.style.background = '#dc2626';
          } else {
            btn.textContent = '🗺 地図に表示';
            btn.style.background = '#f59e0b';
          }
        }
      }
      if (key === 'koku') {
        applyKokuStatusFilter();
        updateKokuSubControls();
      }
    };

    function updateToggleCheckbox(key) {
      const cb = document.getElementById('layer-cb-' + key);
      if (cb) cb.checked = layerVisibility[key];
      if (key === 'koku') updateKokuSubControls();
    }

    // データ読み込み（キャッシュ回避）
    const _cacheBuster = '_t=' + Date.now();
    function freshFetch(url) {
      const sep = url.includes('?') ? '&' : '?';
      return fetch(url + sep + _cacheBuster);
    }

    function loadGeoJSON(url) {
      return freshFetch(url)
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => data.features || [])
        .catch(err => { console.warn(url, err); return []; });
    }

    // X投稿データ読み込み
    function loadXPosts() {
      return freshFetch('data/x_posts.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { xPostsData = data.posts || []; })
        .catch(err => { console.warn('X投稿データ読み込み失敗:', err); xPostsData = []; });
    }

    // 雪捨て場データ読み込み
    function loadDumpSites() {
      return freshFetch('data/snow_dump_sites.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { dumpSites = data.sites || []; })
        .catch(err => { console.warn('雪捨て場データ読み込み失敗:', err); dumpSites = []; });
    }

    // 流雪溝施設データ読み込み
    function loadRyusetsuko() {
      return freshFetch('data/ryusetsuko.geojson')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { ryusetsukoData = (data && data.features) || []; })
        .catch(err => { console.warn('流雪溝データ読み込み失敗:', err); ryusetsukoData = []; });
    }

    // FMSリスクデータ読み込み
    function loadFmsRisk() {
      return freshFetch('data/fms_risk.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { fmsRisk = (data && data.areas) || {}; })
        .catch(err => { console.warn('FMSリスク読み込み失敗:', err); fmsRisk = {}; });
    }

    // 前日サマリー読み込み
    function loadPrevSummary() {
      return freshFetch('data/prev_summary.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { prevSummary = data || null; })
        .catch(err => { console.warn('前日サマリー読み込み失敗:', err); prevSummary = null; });
    }

    // FMS投稿数読み込み
    function loadFmsCounts() {
      return freshFetch('data/fms_counts.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { fmsCounts = data || {}; })
        .catch(err => { console.warn('FMSデータ読み込み失敗:', err); fmsCounts = {}; });
    }

    // 国道除雪状況データ読み込み
    function loadKokudoStatus() {
      return freshFetch('data/kokudo_status.geojson')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { kokudoFeatures = data.features || []; })
        .catch(err => { console.warn('国道除雪状況読み込み失敗:', err); kokudoFeatures = []; });
    }

    // 応援除雪工区データ読み込み
    function loadSupportZones() {
      return freshFetch('data/support_zones.geojson')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { supportZones = data.features || []; })
        .catch(err => { console.warn('応援除雪工区読み込み失敗:', err); supportZones = []; });
    }

    function loadKosodateEvents() {
      return freshFetch('data/kosodate_events.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => {
          kosodateEvents = data.items || [];
          kosodateWindow = data.window || null;
          kosodateMonitoring = data.monitoring || (data.updated_at ? { checked_at: data.updated_at } : null);
        })
        .catch(err => {
          console.warn('子育てイベント読み込み失敗:', err);
          kosodateEvents = [];
          kosodateWindow = null;
          kosodateMonitoring = null;
        });
    }

    // スパネ度読み込み
    function loadSpaneIndex() {
      return freshFetch('data/spane_index.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { spaneData = data; })
        .catch(() => { spaneData = null; });
    }

    // スパネ度の色を返す
    function spaneColor(idx) {
      if (idx >= 70) return '#795548';
      if (idx >= 40) return '#e67e22';
      if (idx >= 15) return '#f39c12';
      return '#3498db';
    }

    // スパネ度コロプレスレイヤーを描画
    function renderSpaneLayer() {
      spaneLayer.clearLayers();
      if (!spaneData || !spaneData.zones || !allFeatures) return;
      const zones = spaneData.zones;
      allFeatures.forEach(function(feat) {
        const name = feat.properties && feat.properties['名前'];
        if (!name || !(name in zones)) return;
        const zone = zones[name];
        const color = spaneColor(zone.spane_index);
        L.geoJSON(feat, {
          style: { color: color, fillColor: color, fillOpacity: 0.7, weight: 1, opacity: 0.8 },
        })
        .bindTooltip(escapeHtml(name) + ' スパネ度: ' + escapeHtml(String(zone.spane_index)) + '（' + escapeHtml(String(zone.level)) + '）<br>除雪から' + escapeHtml(String(zone.days_since_clearance)) + '日', { sticky: true })
        .addTo(spaneLayer);
      });
    }

    // スパネ度フローティングパネル描画（市全体サマリー）
    function renderSpanePanel() {
      if (!spaneDiv) return;
      if (!spaneData || !spaneData.base || !layerVisibility.spane) {
        spaneDiv.style.display = 'none';
        return;
      }
      const base = spaneData.base;
      const top = spaneData.top_zone;
      const color = spaneColor(base.city_spane);
      const tempSourceLabel = base.temp_source === 'current_weather' ? '現在気温' : '日次気温';
      const tempObserved = base.temp_observed_at ? ' / ' + escapeHtml(String(base.temp_observed_at)) : '';
      spaneDiv.style.display = '';
      spaneDiv.innerHTML =
        '<div style="font-size:10px;font-weight:bold;color:#555;margin-bottom:2px">スパネ度</div>' +
        '<div class="spane-value" style="color:' + color + '">' + escapeHtml(String(base.city_spane)) + '</div>' +
        '<div class="spane-sub">' + escapeHtml(String(base.temp_avg_c)) + '℃ × 積雪' + escapeHtml(String(base.snow_depth_cm)) + 'cm</div>' +
        '<div class="spane-sub" style="font-size:9px;color:#888">' + tempSourceLabel + tempObserved + '</div>' +
        (top ? '<div class="spane-sub" style="margin-top:3px">最高 ' + escapeHtml(String(top.spane_index)) + '（' + escapeHtml(String(top.name)) + '）</div>' : '') +
        '<div class="spane-sub" style="font-size:9px;color:#aaa">' + escapeHtml(String(spaneData.date || '')) + '</div>';
    }

    // FMSリスクパネル表示
    function showFmsRiskPanel() {
      const container = document.getElementById('fms-risk-panel');
      const areas = Object.entries(fmsRisk).filter(([, d]) => d.total > 0);
      if (areas.length === 0) { container.innerHTML = ''; return; }

      // 工区→路線の順、その中でスタック件数→総件数の降順
      const catOrder = { koku: 0, rosen: 1 };
      areas.sort((a, b) => {
        const ca = catOrder[a[1].category] ?? 2;
        const cb = catOrder[b[1].category] ?? 2;
        if (ca !== cb) return ca - cb;
        return (b[1].stuck_total - a[1].stuck_total) || (b[1].total - a[1].total);
      });

      const kokuAreas = areas.filter(([, d]) => d.category === 'koku');
      const rosenAreas = areas.filter(([, d]) => d.category === 'rosen');
      const stuckAreas = areas.filter(([, d]) => d.stuck_total > 0);
      const totalReports = areas.reduce((s, [, d]) => s + d.total, 0);
      const operatorMood = window.FaceScore ? window.FaceScore.getOperatorMood(xPostsData) : { available: false };

      let html = '<div class="bus-section">';
      html += `<h4 style="cursor:pointer;user-select:none" data-action="toggle-display" data-target="fms-risk-detail">`;
      html += `市民報告 直近7日間（${areas.length}エリア・${totalReports}件）`;
      if (stuckAreas.length > 0) {
        html += ` <span style="background:#c0392b;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px">⚠${stuckAreas.length}</span>`;
      }
      html += ' <span style="font-size:11px;color:#888">▶</span></h4>';
      html += `<div style="font-size:10px;color:#aaa;margin-bottom:4px">工区${kokuAreas.length} / 路線${rosenAreas.length}　※直近7日間を毎日更新（古い投稿は自動で入れ替わります）</div>`;
      if (operatorMood.available) {
        const confidence = operatorMood.confidence === 'low' ? '・参考値' : '';
        html += `<div style="font-size:11px;margin-bottom:6px;color:${operatorMood.color};font-weight:bold">除雪業者ムード（全体）: ${operatorMood.emoji} ${operatorMood.label} <span style="font-weight:normal;color:#888">対象${operatorMood.total}件${confidence}</span></div>`;
      }
      html += '<div id="fms-risk-detail" style="display:none">';

      function renderAreaCard(name, data) {
        const hasStuck = data.stuck_total > 0;
        const borderColor = hasStuck ? '#c0392b' : '#e5e7eb';
        const safeNameAttr = name.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
        const catLabel = data.category === 'koku' ? '工区' : '路線';
        const catColor = data.category === 'koku' ? '#1a3a5c' : '#6b7280';
        const snowText = data.days_since_snow != null ? `除雪${data.days_since_snow}日前` : '除雪日不明';
        const face = window.FaceScore ? window.FaceScore.getAreaFace(data) : { available: false };
        const operatorMoodLocal = window.FaceScore ? window.FaceScore.getOperatorMoodForArea(name, xPostsData) : { available: false };
        const faceChip = face.available
          ? `<span style="display:inline-block;background:${face.color};color:#fff;font-size:9px;border-radius:10px;padding:1px 6px;margin-left:6px">${face.emoji} ${face.scoreText}</span>`
          : '';

        let card = `<div style="border:1px solid ${borderColor};border-radius:6px;padding:8px;margin-bottom:6px;cursor:pointer;${hasStuck ? 'background:#fef2f2' : ''}" data-area="${safeNameAttr}" data-action="select-area-by-name">`;
        card += `<div style="font-size:12px;font-weight:bold;color:${catColor};margin-bottom:3px">`;
        card += `<span style="font-size:9px;background:${catColor};color:#fff;padding:1px 5px;border-radius:4px;margin-right:4px">${catLabel}</span>`;
        card += escapeHtml(name);
        card += faceChip;
        card += `<span style="font-size:10px;color:#888;font-weight:normal;margin-left:6px">${snowText}</span>`;
        card += ' <span style="font-size:10px;color:#3498db">▶ 地図で見る</span>';
        card += '</div>';
        if (operatorMoodLocal.available) {
          card += `<div style="font-size:10px;color:${operatorMoodLocal.color};margin-bottom:3px">除雪業者: ${operatorMoodLocal.emoji} ${operatorMoodLocal.label}</div>`;
        }

        const riskItems = [
          ['スタック', data.risk.stacked, '#c0392b'],
          ['走行注意', data.risk.near_stack, '#e67e22'],
          ['通行困難', data.risk.passable_slow, '#f39c12'],
          ['改善', data.risk.resolved, '#27ae60'],
        ];
        riskItems.forEach(([label, count, color]) => {
          if (count === 0) return;
          card += `<div style="font-size:10px;margin-bottom:1px">`;
          card += `<span style="display:inline-block;width:55px;color:#666">${label}</span>`;
          const barW = Math.min(Math.max(count * 10, 8), 60);
          card += `<span style="display:inline-block;width:${barW}px;height:8px;background:${color};border-radius:2px;vertical-align:middle;margin-right:3px"></span>`;
          card += `<span style="color:#888">${count}</span>`;
          card += '</div>';
        });

        card += '</div>';
        return card;
      }

      if (kokuAreas.length > 0) {
        html += `<div style="font-size:11px;font-weight:bold;color:#1a3a5c;margin:8px 0 4px;border-bottom:1px solid #ddd;padding-bottom:3px">工区（${kokuAreas.length}）</div>`;
        kokuAreas.forEach(([name, data]) => { html += renderAreaCard(name, data); });
      }
      if (rosenAreas.length > 0) {
        html += `<div style="font-size:11px;font-weight:bold;color:#6b7280;margin:12px 0 4px;border-bottom:1px solid #ddd;padding-bottom:3px">路線（${rosenAreas.length}）</div>`;
        rosenAreas.forEach(([name, data]) => { html += renderAreaCard(name, data); });
      }

      html += '<div style="font-size:10px;color:#aaa;margin-top:6px">※FMS(FixMyStreet)投稿の統計。解決済みも記録として表示。</div>';
      html += '</div></div>';
      container.innerHTML = html;
    }

    // 市営バス運行状況データ読み込み
    function loadBusStatus() {
      return freshFetch('data/bus_status.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { busStatusData = data || null; })
        .catch(err => { console.warn('バス運行状況データ読み込み失敗:', err); busStatusData = null; });
    }

    // バス運休路線GeoJSON読み込み
    function loadBusSuspended() {
      return freshFetch('data/bus_suspended.geojson')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { busSuspendedData = data || null; })
        .catch(err => { console.warn('バス運休路線データ読み込み失敗:', err); busSuspendedData = null; });
    }

    function renderBusList(title, items, withType) {
      if (!items || items.length === 0) return '';
      let html = '<div class="bus-list">';
      html += `<div class="bus-list-title">${escapeHtml(title)}</div>`;
      items.forEach(item => {
        html += '<div class="bus-item">';
        html += `<span class="route">${escapeHtml(item.route || '')}</span>`;
        if (withType && item.type) html += `（${escapeHtml(item.type)}）`;
        if (item.detail) html += `: ${escapeHtml(item.detail)}`;
        html += '</div>';
      });
      html += '</div>';
      return html;
    }

    // バス運休路線の地図表示トグル（パネルボタンから呼ばれる）
    window.toggleBusLayers = function() {
      toggleLayer('bus');
    };

    function showBusStatus() {
      const container = document.getElementById('bus-status');
      if (!busStatusData) {
        container.innerHTML = '';
        return;
      }

      // resumed のうち type 付き（実際はまだ運休/迂回中）を continuing 側に振り分け
      const rawResumed = busStatusData.resumed || [];
      const trueResumed = rawResumed.filter(r => !r.type);
      const falseResumed = rawResumed.filter(r => r.type);
      const effectiveContinuing = [...(busStatusData.continuing || []), ...falseResumed];

      // 運休件数をカウント
      const issueCount = (busStatusData.new_info || []).length + effectiveContinuing.length;
      const badge = issueCount > 0 ? ` <span class="bus-badge">${issueCount}</span>` : '';
      const hasSuspended = busLayers.length > 0;

      let html = '<div class="bus-section">';
      html += `<h4 style="cursor:pointer;user-select:none" data-action="toggle-display" data-target="bus-detail">🚌 市営バス運行状況${badge} <span style="font-size:11px;color:#888">▶</span></h4>`;
      html += `<div class="bus-meta">最終更新: ${escapeHtml(busStatusData.updated_at || '-')}</div>`;
      if (hasSuspended) {
        html += `<button id="bus-map-toggle" data-action="toggle-bus-layers" style="background:#f59e0b;color:#fff;border:none;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer;margin-bottom:8px">🗺 地図に表示</button>`;
      }
      html += '<div id="bus-detail" style="display:none">';

      if (busStatusData.next_update_notice) {
        const prep = busStatusData.next_update_notice;
        html += '<div class="bus-note">';
        html += `${escapeHtml(prep.date || '')} <span class="bus-badge">${escapeHtml(prep.status || '')}</span><br>`;
        html += `${escapeHtml(prep.message || '')}`;
        html += '</div>';
      }

      html += renderBusList('新着情報', busStatusData.new_info, true);
      html += renderBusList('運休解除（通常運行）', trueResumed, false);
      html += renderBusList('運休・迂回継続', effectiveContinuing, true);

      if (busStatusData.notes && busStatusData.notes.length > 0) {
        html += '<div class="bus-list"><div class="bus-list-title">備考</div>';
        busStatusData.notes.forEach(n => { html += `<div class="bus-note">・${escapeHtml(n)}</div>`; });
        html += '</div>';
      }
      if (busStatusData.contacts && busStatusData.contacts.length > 0) {
        html += '<div class="bus-list"><div class="bus-list-title">問い合わせ</div>';
        busStatusData.contacts.forEach(c => { html += `<div class="bus-note">${escapeHtml(c.name)}: ${escapeHtml(c.tel)}</div>`; });
        html += '</div>';
      }

      html += '<div style="font-size:10px;color:#aaa;margin-top:8px">出典: <a href="https://aomori100.shizentai.jp/oshirase/oshirase.html" target="_blank" rel="noopener" style="color:#aaa">青森市交通部 お知らせ</a></div>';
      html += '</div></div>';
      container.innerHTML = html;
    }

    // 工区メタデータ読み込み
    function loadAreasMeta() {
      return freshFetch('data/areas_meta.json')
        .then(res => res.ok ? res.json() : Promise.reject(res.status))
        .then(data => { areasMeta = data.areas || {}; })
        .catch(err => { console.warn('メタデータ読み込み失敗:', err); areasMeta = {}; });
    }

    Promise.all([
      loadGeoJSON('data/koku.geojson'),
      loadGeoJSON('data/rosen.geojson'),
      loadXPosts(),
      loadAreasMeta(),
      loadDumpSites(),
      loadRyusetsuko(),
      loadKokudoStatus(),
      loadFmsCounts(),
      loadFmsRisk(),
      loadPrevSummary(),
      loadBusStatus(),
      loadBusSuspended(),
      loadSupportZones(),
      loadSpaneIndex(),
      loadKosodateEvents(),
    ]).then(([kokuFeatures, rosenFeatures]) => {
      // スパネ度パネル描画・レイヤー初期化
      renderSpanePanel();
      renderSpaneLayer();

      // 路面状況予測を計算
      if (window.RoadPredict && fmsRisk) {
        roadPredictions = window.RoadPredict.predictAllAreas(fmsRisk, areasMeta);
      }

      kokuFeatures.forEach(function(feature) { feature._source = 'koku'; });
      rosenFeatures.forEach(function(feature) { feature._source = 'rosen'; });
      const combined = [...kokuFeatures, ...rosenFeatures];
      allFeatures = combined;

      combined.forEach((feature, i) => {
        feature._globalIndex = i;
        const layer = L.geoJSON(feature, {
          style: styleFeature,
          onEachFeature: function(feat, lyr) {
            // ツールチップ（ホバーで工区名表示）
            lyr.bindTooltip(escapeHtml(feat.properties['名前']), {
              sticky: true,
              direction: 'top',
              className: 'area-tooltip',
            });
            lyr.on('click', onFeatureClick);
          }
        }).addTo(kokuLayer);

        // geoJSONレイヤーの最初の子レイヤーを取得
        const innerLayer = layer.getLayers()[0];
        const statusClass = classifyStatus(feature.properties['ステータス']);
        let labelLayer = null;
        if (innerLayer) {
          innerLayer.feature = feature;
          allLayers.push({ layer: innerLayer, feature: feature, source: feature._source, statusClass: statusClass, labelLayer: null });
        }

        // ポリゴンの中心にラベルを表示
        if (feature.geometry.type === 'Polygon') {
          const meta = areasMeta[feature.properties['名前']];
          if (meta && meta.centroid) {
            const areaName = feature.properties['名前'];
            let labelHtml = escapeHtml(areaName);
            const risk = fmsRisk[areaName];
            if (risk && risk.stuck_total > 0) {
              labelHtml += `<span style="display:inline-block;background:#c0392b;color:#fff;font-size:8px;font-weight:bold;border-radius:6px;padding:0 3px;margin-left:2px;vertical-align:top;text-shadow:none;line-height:1.4">⚠${risk.stuck_total}</span>`;
            } else if (risk && risk.total > 0) {
              labelHtml += `<span style="display:inline-block;background:#8b5cf6;color:#fff;font-size:8px;font-weight:bold;border-radius:6px;padding:0 3px;margin-left:2px;vertical-align:top;text-shadow:none;line-height:1.4">${risk.total}</span>`;
            }
            labelLayer = L.marker([meta.centroid[1], meta.centroid[0]], {
              icon: L.divIcon({
                className: 'area-label',
                html: labelHtml,
                iconSize: null,
              }),
              interactive: false,
            }).addTo(kokuLayer);
          }
        }
        if (innerLayer) {
          const last = allLayers[allLayers.length - 1];
          if (last && last.layer === innerLayer) {
            last.labelLayer = labelLayer;
          }
        }
      });
      applyKokuStatusFilter();
      updateKokuSubControls();
      if (layerVisibility.koku) kokuLayer.addTo(map);

      // 雪捨て場マーカー表示
      dumpSiteLayer.clearLayers();
      dumpSites.forEach(site => {
        if (site.lat == null || site.lng == null) return;
        const icon = L.divIcon({
          className: '',
          html: '<div class="dump-icon">&#10052;</div>',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        });
        const marker = L.marker([site.lat, site.lng], { icon: icon });
        let popupHtml = `<b>${escapeHtml(site.name)}</b><br>`;
        popupHtml += `<span style="color:#666">${escapeHtml(site.type)}</span>`;
        if (site.hours) popupHtml += `<br>受入時間: ${escapeHtml(site.hours)}`;
        if (site.notes) popupHtml += `<br>${escapeHtml(site.notes)}`;
        marker.bindPopup(popupHtml);
        marker.bindTooltip(escapeHtml(site.name), { direction: 'top', className: 'dump-tooltip' });
        dumpSiteLayer.addLayer(marker);
      });
      if (layerVisibility.dump) dumpSiteLayer.addTo(map);

      // 流雪溝施設マーカー表示
      ryusetsukoLayer.clearLayers();
      ryusetsukoData.forEach(feature => {
        const props = feature.properties;
        const coords = feature.geometry.coordinates;
        const func = props.function || '';
        let cssClass = 'pump';
        let emoji = '💧';
        if (func.includes('排水')) { cssClass = 'drain'; emoji = '🔽'; }
        else if (func.includes('取水') || func.includes('排湯')) { cssClass = 'intake'; emoji = '🔼'; }
        const icon = L.divIcon({
          className: '',
          html: `<div class="ryusetsu-icon ${cssClass}">${emoji}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const marker = L.marker([coords[1], coords[0]], { icon: icon });
        let popupHtml = `<b>${escapeHtml(props.name)}</b><br>`;
        popupHtml += `<span style="color:#666">${escapeHtml(props.category)} / ${escapeHtml(func)}</span><br>`;
        popupHtml += `系統: ${escapeHtml(props.system)}`;
        if (props.note) popupHtml += `<br>${escapeHtml(props.note)}`;
        popupHtml += `<br><span style="font-size:10px;color:#aaa">出典: ${escapeHtml(props.source)}</span>`;
        marker.bindPopup(popupHtml);
        marker.bindTooltip(escapeHtml(props.name), { direction: 'top', className: 'ryusetsu-tooltip' });
        ryusetsukoLayer.addLayer(marker);
      });
      if (layerVisibility.ryusetsuko) ryusetsukoLayer.addTo(map);

      // 国道除雪状況レイヤー表示
      kokudoLayer.clearLayers();
      kokudoFeatures.forEach(feature => {
        const color = feature.properties.color || '#999';
        const status = feature.properties.status || '';
        const lyr = L.geoJSON(feature, {
          style: { color: color, weight: 5, opacity: 0.8 },
        });
        lyr.bindPopup(`<b>国道区間 #${escapeHtml(String(feature.properties.id))}</b><br>状況: ${escapeHtml(status)}<br><span style="color:#888;font-size:11px">${escapeHtml(feature.properties.source)}</span>`);
        lyr.bindTooltip(escapeHtml(status), { sticky: true, direction: 'top' });
        kokudoLayer.addLayer(lyr);
      });
      if (layerVisibility.kokudo) kokudoLayer.addTo(map);

      // バス運休路線レイヤー準備（初期非表示）
      // new_info（本日新規）+ continuing（継続中）に載っている路線のみ表示するホワイトリスト方式
      // continuing が空なら全路線通常運行 → 何も表示しない
      const activelySuspendedRoutes = [
        ...(busStatusData && busStatusData.new_info ? busStatusData.new_info.map(r => r.route) : []),
        ...(busStatusData && busStatusData.continuing ? busStatusData.continuing.map(r => r.route) : []),
      ];
      busLayer.clearLayers();
      busLayers = [];
      if (busSuspendedData && busSuspendedData.features && activelySuspendedRoutes.length > 0) {
        busSuspendedData.features.filter(feature => {
          const featureBaseName = feature.properties.name.split('（')[0];
          return activelySuspendedRoutes.some(route =>
            feature.properties.name.includes(route) || route.includes(featureBaseName)
          );
        }).forEach(feature => {
          const props = feature.properties;
          // 運休区間ライン（赤太線 + 白破線で❌感）
          const busLine = L.geoJSON(feature, {
            style: { color: '#dc2626', weight: 7, opacity: 0.9 },
          });
          const busDash = L.geoJSON(feature, {
            style: { color: '#fff', weight: 3, opacity: 0.8, dashArray: '8, 12' },
          });

          let popupHtml = `<div style="min-width:180px">`;
          popupHtml += `<div style="font-size:14px;font-weight:bold;color:#dc2626;margin-bottom:4px">❌ ${escapeHtml(props.name)}</div>`;
          popupHtml += `<div style="font-size:12px;margin-bottom:4px"><span style="background:#dc2626;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:bold">${escapeHtml(props.status)}</span></div>`;
          popupHtml += `<div style="font-size:12px;margin-bottom:3px"><b>運休区間:</b> ${escapeHtml(props.from_stop)} ～ ${escapeHtml(props.to_stop)}</div>`;
          if (props.detour_notice) {
            popupHtml += `<div style="font-size:11px;color:#666;margin-bottom:3px;background:#fef2f2;padding:6px;border-radius:4px">${escapeHtml(props.detour_notice)}</div>`;
          }
          if (props.stops && props.stops.length > 0) {
            popupHtml += `<div style="font-size:10px;color:#888;border-top:1px solid #eee;padding-top:4px;margin-top:4px">`;
            popupHtml += `停留所: ${props.stops.map(s => escapeHtml(s.name)).join(' → ')}`;
            popupHtml += `</div>`;
          }
          popupHtml += `</div>`;
          busLine.bindPopup(popupHtml);
          busLine.bindTooltip(`❌ ${escapeHtml(props.name)}（${escapeHtml(props.status)}）`, { sticky: true, direction: 'top' });

          // 停留所❌マーカー
          if (props.stops) {
            props.stops.forEach(stop => {
              const icon = L.divIcon({
                className: '',
                html: '<div style="width:18px;height:18px;background:#dc2626;border:2px solid #fff;border-radius:50%;box-shadow:0 2px 6px rgba(220,38,38,0.5);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;font-weight:bold">✕</div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
              });
              const m = L.marker([stop.lat, stop.lng], { icon: icon });
              m.bindTooltip(`❌ ${escapeHtml(stop.name)}（運休中）`, { direction: 'top', className: 'dump-tooltip' });
              busLayer.addLayer(m);
            });
          }

          busLayer.addLayer(busLine);
          busLayer.addLayer(busDash);
          busLayers.push({ line: busLine, dash: busDash });
        });
      }
      // バスは初期非表示（layerVisibility.bus = false）

      // 応援除雪工区レイヤー表示（作業予定期間を日付で判定）
      supportLayer.clearLayers();
      const _today = new Date(); _today.setHours(0, 0, 0, 0);
      supportZones.forEach(feature => {
        const props = feature.properties;
        const period = props['作業予定期間（開始予定日～終了予定日）'] || '';
        if (!period.trim()) return;
        const [startD, endD] = parsePeriodDates(period);
        if (!startD || !endD) return;
        let fillColor, fillOpacity, weight, borderColor;
        if (startD <= _today && _today <= endD) {
          fillColor = '#2e7d32'; fillOpacity = 0.45; weight = 2; borderColor = '#2e7d32';
        } else if (endD < _today) {
          fillColor = '#78909c'; fillOpacity = 0.15; weight = 1; borderColor = '#78909c';
        } else {
          // 将来予定（薄いオレンジ）
          fillColor = '#f57f17'; fillOpacity = 0.25; weight = 1.5; borderColor = '#f57f17';
        }
        const zoneName = props['工区名'] || props['名前'] || '';
        const meta = areasMeta[zoneName] || {};
        const quarter = (meta.address_detail && meta.address_detail.quarter) || '';
        const label = quarter ? `${quarter}(${zoneName})` : zoneName;
        const lyr = L.geoJSON(feature, {
          style: { color: borderColor, weight: weight, fillColor: fillColor, fillOpacity: fillOpacity },
        }).bindTooltip(`応援除雪 ${escapeHtml(label)}<br>${escapeHtml(period.trim())}`, { sticky: true });
        supportLayer.addLayer(lyr);
      });
      if (layerVisibility.support) supportLayer.addTo(map);

      // 子育て・学びイベントマーカー表示
      kidsAdminLayer.clearLayers();
      kidsPrivateLayer.clearLayers();
      kidsEventMarkers = {};
      kosodateEvents.forEach(ev => {
        if (ev.lat == null || ev.lng == null) return;
        const catLabel = kidsCategoryLabel(ev.category);
        const catColor = kidsCategoryColor(ev.category);
        const icon = L.divIcon({
          className: '',
          html: '<div class="kids-event-icon" style="background:' + catColor + '">★</div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        });
        const marker = L.marker([ev.lat, ev.lng], { icon: icon });
        const safeUrl = (ev.url && /^https?:\/\//.test(ev.url)) ? ev.url : '#';
        const popupHtml = [
          `<div style="min-width:220px">`,
          `<div style="margin-bottom:4px"><span style="font-size:10px;background:${catColor};color:#fff;padding:2px 6px;border-radius:999px">${catLabel}</span></div>`,
          `<div style="font-size:14px;font-weight:bold;color:#be185d;margin-bottom:4px">${escapeHtml(ev.title || '子育てイベント')}</div>`,
          `<div style="font-size:12px;line-height:1.6">`,
          `<div><b>何月:</b> ${escapeHtml(ev.month || '未設定')}</div>`,
          `<div><b>何時:</b> ${escapeHtml(ev.time || '未設定')}</div>`,
          `<div><b>場所:</b> ${escapeHtml(ev.place || '未設定')}</div>`,
          `<div><b>内容:</b> ${escapeHtml(ev.summary || '未設定')}</div>`,
          ev.fee ? `<div><b>参加費:</b> ${escapeHtml(ev.fee)}</div>` : '',
          `</div>`,
          `<div style="margin-top:8px">`,
          `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener" style="display:inline-block;background:#be185d;color:#fff;text-decoration:none;padding:6px 10px;border-radius:6px;font-size:11px;font-weight:bold">${escapeHtml(ev.apply || '申し込みはこちらから')}</a>`,
          `</div>`,
          ev.source ? `<div style="font-size:10px;color:#888;margin-top:6px">出典: ${escapeHtml(ev.source)}</div>` : '',
          `</div>`,
        ].join('');
        marker.bindPopup(popupHtml);
        marker.bindTooltip(escapeHtml(ev.title) || '子育てイベント', { direction: 'top', className: 'dump-tooltip' });
        if (ev.category === 'private_general') {
          kidsPrivateLayer.addLayer(marker);
        } else {
          kidsAdminLayer.addLayer(marker);
        }
        if (ev.id) kidsEventMarkers[ev.id] = { marker: marker, category: ev.category || 'administration' };
      });
      if (layerVisibility.kids_admin) kidsAdminLayer.addTo(map);
      if (layerVisibility.kids_private) kidsPrivateLayer.addTo(map);

      buildSummary(kokuFeatures, rosenFeatures);
      showBusStatus();
      showFmsRiskPanel();

      // 全体表示
      if (allLayers.length > 0) {
        const group = L.featureGroup(allLayers.map(l => l.layer));
        if (group.getBounds().isValid()) {
          map.fitBounds(group.getBounds(), { padding: [20, 20] });
        }
      }

      document.getElementById('update-time').textContent =
        '最終読込: ' + new Date().toLocaleString('ja-JP');

      // データ読み込み完了
      dataReady = true;
      if (currentView === 'dashboard') renderDashboard();
      if (currentView === 'navi') renderNaviView();
      if (activePurposeKey === 'learning') {
        renderKidsDashboard();
        updatePurposePanelLayout();
      }

      // ディープリンク: ?area=工区名 でマップ遷移＋エリア選択
      const urlParams = new URLSearchParams(window.location.search);
      const areaParam = urlParams.get('area');
      if (areaParam) {
        switchView('map');
        setTimeout(function() { selectAreaByName(areaParam); }, 300);
      }
    });

    // モーダル制御
    window.openModal = function() {
      document.getElementById('terms-modal').classList.add('active');
    };
    window.closeModal = function(e) {
      if (!e || e.target === document.getElementById('terms-modal')) {
        document.getElementById('terms-modal').classList.remove('active');
      }
    };

    function renderFeatureVideo() {
      const box = document.getElementById('feature-video-container');
      if (!box) return;
      if (!FEATURE_VIDEO_URL) {
        box.className = 'video-empty';
        box.textContent = '動画URLを設定すると、ここに埋め込み表示されます。';
        return;
      }
      box.className = '';
      var safeVideoUrl = /^https:\/\/(www\.youtube\.com|player\.vimeo\.com)\//.test(FEATURE_VIDEO_URL) ? FEATURE_VIDEO_URL : '';
      if (!safeVideoUrl) { box.className = 'video-empty'; box.textContent = '有効な動画URLを設定してください。'; return; }
      box.innerHTML = `<iframe class="video-embed" src="${safeVideoUrl}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen sandbox="allow-scripts allow-same-origin"></iframe>`;
    }
    window.openFeatureModal = function() {
      renderFeatureVideo();
      document.getElementById('feature-modal').classList.add('active');
    };
    window.closeFeatureModal = function(e) {
      if (!e || e.target === document.getElementById('feature-modal')) {
        document.getElementById('feature-modal').classList.remove('active');
      }
    };

    function escapeHtml(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // Service Worker登録
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }

    // CSP対応: インラインイベントハンドラの代替（data-action ディスパッチャ）
    var DATA_ACTIONS = {
      'switch-view': function(el, arg) { switchView(arg); },
      'nav-to': function(el, arg, e) { navTo(arg, e); },
      'toggle-nav-menu': function(el, arg, e) { toggleNavMenu(e); },
      'toggle-share-menu': function(el, arg, e) { toggleShareMenu(e); },
      'share-to': function(el, arg, e) { shareTo(arg, e); },
      'reload': function() { location.reload(); },
      'open-feature-modal': function() { openFeatureModal(); },
      'close-feature-modal': function(el, arg, e) { closeFeatureModal(e); },
      'close-feature-modal-force': function() { closeFeatureModal(); },
      'open-modal': function() { openModal(); },
      'close-modal': function(el, arg, e) { closeModal(e); },
      'close-modal-force': function() { closeModal(); },
      'select-purpose': function(el, arg) { selectPurpose(arg); },
      'reset-view': function() { resetView(); },
      'share-to-x': function() { shareToX(); },
      'toggle-area-list': function() { toggleAreaList(); },
      'focus-kids-event': function(el, arg) { focusKidsEvent(arg); },
      'toggle-kids-accordion': function(el, arg) { toggleKidsAccordion(arg); },
      'set-navi-mode': function(el, arg) { setNaviTransportMode(arg); },
      'start-navi-pick': function(el, arg) { startNaviMapPick(arg); },
      'clear-navi-dest': function() { clearNaviDest(); },
      'search-route': function() { searchRoute(); },
      'select-navi-route': function(el, arg) { selectNaviRoute(Number(arg)); },
      'show-route-on-map': function() { showRouteOnMap(); },
      'share-area': function(el) { shareArea(el.dataset.area); },
      'select-area': function(el, arg) { selectArea(Number(arg)); },
      'select-area-by-name': function(el) { selectAreaByName(el.dataset.area); },
      'filter-by-card': function(el) { filterByCard(el.dataset.type, el.dataset.key); },
      'dash-filter': function(el) {
        switchView('map');
        setTimeout(function() { filterByCard(el.dataset.type, el.dataset.key); }, 200);
      },
      'toggle-block': function(el) {
        var b = document.getElementById(el.dataset.target);
        if (!b) return;
        var i = el.querySelector('.ti');
        if (b.style.display === 'none') { b.style.display = ''; if (i) i.textContent = '▼'; }
        else { b.style.display = 'none'; if (i) i.textContent = '▶'; }
      },
      'toggle-display': function(el) {
        var t = document.getElementById(el.dataset.target);
        if (t) t.style.display = t.style.display === 'none' ? 'block' : 'none';
      },
      'toggle-bus-layers': function() { toggleBusLayers(); },
      'toggle-layer': function(el, arg) { toggleLayer(arg); },
      'toggle-koku-status': function(el, arg) { toggleKokuStatus(arg); },
    };
    document.addEventListener('click', function(e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
      if (!el || el.disabled) return;
      var fn = DATA_ACTIONS[el.dataset.action];
      if (fn) fn(el, el.dataset.arg, e);
    });
    document.addEventListener('change', function(e) {
      var el = e.target && e.target.closest ? e.target.closest('[data-action-change]') : null;
      if (!el || el.disabled) return;
      var fn = DATA_ACTIONS[el.dataset.actionChange];
      if (fn) fn(el, el.dataset.arg, e);
    });
