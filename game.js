/* =========================================================
   MOCHI POP — Match-3 game for Garnier Mochi vertical kiosk
   ========================================================= */

(() => {
  'use strict';

  /* ---------- constants ---------- */
  const COLS = 6;
  const ROWS = 8;
  const NUM_COLORS = 3;
  const GAME_TIME = 45;          // seconds
  const COLOR_NAMES = ['yellow', 'pink', 'blue'];

  const POWERUP_NONE = 0;
  const POWERUP_BOMB = 1;
  const POWERUP_LINE = 2;

  const ANIM = {
    swap:    250,   // ms
    pop:     320,
    fall:    200,
    spawn:   200,
    cascade: 120,   // pause between cascade rounds
    powerup: 450,   // power-up activation effect
  };

  /* ---------- state ---------- */
  let grid;            // [row][col] → colour index (0-2), -1 = empty
  let powerUpGrid;     // [row][col] → POWERUP_NONE / POWERUP_BOMB / POWERUP_LINE
  let cellEls;         // [row][col] → DOM .cell element
  let cellSize;        // px, computed on layout
  let score, timeLeft, timerInterval;
  let isProcessing;    // block input during animations
  let gameActive;
  let currentScreen;
  let playerName = '';

  /* touch / mouse tracking */
  let pointerDown   = false;
  let startX, startY, startRow, startCol;

  /* DOM refs */
  const $ = id => document.getElementById(id);
  let gridEl, gridContainer;

  /* ---------- audio ---------- */
  const AUDIO = {
    initialized: false,
    unlocked: false,
    bgm: null,
    ctx: null,
    buffers: {},
    volumes: {}
  };

  async function loadSfx(src, volume) {
    AUDIO.volumes[src] = volume;
    try {
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      if (AUDIO.ctx) {
        AUDIO.buffers[src] = await AUDIO.ctx.decodeAudioData(arrayBuffer);
      }
    } catch (e) {
      console.warn('Failed to load audio:', src, e);
    }
  }

  function initAudio() {
    if (AUDIO.initialized) return;
    AUDIO.initialized = true;

    // HTML5 Audio for BGM
    AUDIO.bgm = new Audio('sfx/bgm.mp3');
    AUDIO.bgm.preload = 'auto';
    AUDIO.bgm.volume = 0.3;
    AUDIO.bgm.loop = true;

    // Web Audio API for SFX
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      AUDIO.ctx = new AudioContext();
      loadSfx('sfx/bomb.wav', 0.75);
      loadSfx('sfx/clearline.wav', 0.7);
      loadSfx('sfx/clearline2.mp3', 0.65);
      loadSfx('sfx/end.wav', 0.8);
      for (let i = 1; i <= 6; i++) {
        loadSfx(`sfx/pop${i}.mp3`, 0.65);
      }
    }
  }

  function unlockAudio() {
    initAudio();
    if (AUDIO.unlocked) return;
    AUDIO.unlocked = true;

    // Unlock Web Audio Context
    if (AUDIO.ctx && AUDIO.ctx.state === 'suspended') {
      AUDIO.ctx.resume();
    }
  }

  function playSfx(src) {
    if (!AUDIO.unlocked || !AUDIO.ctx || !AUDIO.buffers[src]) return;
    if (AUDIO.ctx.state === 'suspended') AUDIO.ctx.resume();

    const source = AUDIO.ctx.createBufferSource();
    source.buffer = AUDIO.buffers[src];

    const gainNode = AUDIO.ctx.createGain();
    gainNode.gain.value = AUDIO.volumes[src] || 1;

    source.connect(gainNode);
    gainNode.connect(AUDIO.ctx.destination);
    source.start(0);
  }

  function playPop(chain) {
    const idx = clamp(chain, 1, 6);
    playSfx(`sfx/pop${idx}.mp3`);
  }

  function playBombSfx() {
    playSfx('sfx/bomb.wav');
  }

  function playLineClearSfx() {
    playSfx('sfx/clearline.wav');
  }

  function playComboSfx() {
    playSfx('sfx/clearline2.mp3');
  }

  function playEndSfx() {
    playSfx('sfx/end.wav');
  }

  function startBgm() {
    if (!AUDIO.unlocked || !AUDIO.bgm) return;
    if (!AUDIO.bgm.paused) return;
    AUDIO.bgm.play().catch(() => {});
  }

  function stopBgm() {
    if (!AUDIO.bgm) return;
    AUDIO.bgm.pause();
    AUDIO.bgm.currentTime = 0;
  }

  /* =========================================================
     SCREEN MANAGEMENT
     ========================================================= */

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(id).classList.add('active');
    currentScreen = id;
  }

  /* =========================================================
     GRID HELPERS
     ========================================================= */

  function rng(max) { return Math.floor(Math.random() * max); }

  function colorAt(r, c) {
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return -1;
    return grid[r][c];
  }

  /** Pick a colour that won't create a match at (r,c) during init. */
  function safeColor(r, c) {
    let avail = [0, 1, 2];
    if (c >= 2 && grid[r][c - 1] === grid[r][c - 2])
      avail = avail.filter(v => v !== grid[r][c - 1]);
    if (r >= 2 && grid[r - 1][c] === grid[r - 2][c])
      avail = avail.filter(v => v !== grid[r - 1][c]);
    return avail[rng(avail.length)];
  }

  function initGrid() {
    grid = [];
    powerUpGrid = [];
    for (let r = 0; r < ROWS; r++) {
      grid[r] = [];
      powerUpGrid[r] = [];
      for (let c = 0; c < COLS; c++) {
        grid[r][c] = safeColor(r, c);
        powerUpGrid[r][c] = POWERUP_NONE;
      }
    }
    if (!hasValidMoves()) shuffleGrid();
  }

  /* =========================================================
     RENDERING
     ========================================================= */

  function computeCellSize() {
    const cw = gridContainer.clientWidth  - 12;   // padding
    const ch = gridContainer.clientHeight - 12;
    cellSize = Math.floor(Math.min(cw / COLS, ch / ROWS));
  }

  function renderGrid() {
    computeCellSize();
    gridEl.innerHTML = '';
    gridEl.style.width  = (cellSize * COLS) + 'px';
    gridEl.style.height = (cellSize * ROWS) + 'px';

    cellEls = [];
    for (let r = 0; r < ROWS; r++) {
      cellEls[r] = [];
      for (let c = 0; c < COLS; c++) {
        const cell = makeCell(r, c, grid[r][c]);
        gridEl.appendChild(cell);
        cellEls[r][c] = cell;
      }
    }
  }

  function makeCell(row, col, colorIdx) {
    const cell = document.createElement('div');
    cell.className = 'cell';

    const pu = powerUpGrid[row][col];
    if (pu === POWERUP_BOMB) cell.classList.add('powerup-bomb');
    else if (pu === POWERUP_LINE) cell.classList.add('powerup-rainbow');

    cell.style.width  = cellSize + 'px';
    cell.style.height = cellSize + 'px';
    positionCell(cell, row, col, false);

    const mochi = document.createElement('div');
    if (pu === POWERUP_BOMB) {
      mochi.className = 'mochi mochi-bomb';
    } else if (pu === POWERUP_LINE) {
      mochi.className = 'mochi mochi-rainbow';
    } else {
      mochi.className = 'mochi mochi-' + COLOR_NAMES[colorIdx];
    }
    cell.appendChild(mochi);

    cell.dataset.row = row;
    cell.dataset.col = col;
    return cell;
  }

  function positionCell(el, row, col, animate) {
    if (animate) {
      el.style.transition = `transform ${ANIM.fall}ms ease-out`;
    } else {
      el.style.transition = 'none';
    }
    el.style.transform = `translate(${col * cellSize}px, ${row * cellSize}px)`;
  }

  /* =========================================================
     MATCH DETECTION
     ========================================================= */

  /** Simple flat set of matched indices — used by hasValidMoves / shuffleGrid. */
  function findMatches() {
    const matched = new Set();

    for (let r = 0; r < ROWS; r++) {
      let run = 1;
      for (let c = 1; c < COLS; c++) {
        if (grid[r][c] === grid[r][c - 1] && grid[r][c] !== -1) {
          run++;
        } else {
          if (run >= 3) for (let k = c - run; k < c; k++) matched.add(r * COLS + k);
          run = 1;
        }
      }
      if (run >= 3) for (let k = COLS - run; k < COLS; k++) matched.add(r * COLS + k);
    }

    for (let c = 0; c < COLS; c++) {
      let run = 1;
      for (let r = 1; r < ROWS; r++) {
        if (grid[r][c] === grid[r - 1][c] && grid[r][c] !== -1) {
          run++;
        } else {
          if (run >= 3) for (let k = r - run; k < r; k++) matched.add(k * COLS + c);
          run = 1;
        }
      }
      if (run >= 3) for (let k = ROWS - run; k < ROWS; k++) matched.add(k * COLS + c);
    }

    return matched;   // Set of (row*COLS + col)
  }

  /** Structured match groups with length and direction, for power-up logic. */
  function findMatchGroups() {
    const groups = [];

    for (let r = 0; r < ROWS; r++) {
      let runStart = 0;
      for (let c = 1; c <= COLS; c++) {
        if (c < COLS && grid[r][c] === grid[r][runStart] && grid[r][c] !== -1) continue;
        const runLen = c - runStart;
        if (runLen >= 3) {
          const cells = new Set();
          for (let k = runStart; k < c; k++) cells.add(r * COLS + k);
          groups.push({ cells, length: runLen, horizontal: true });
        }
        runStart = c;
      }
    }

    for (let c = 0; c < COLS; c++) {
      let runStart = 0;
      for (let r = 1; r <= ROWS; r++) {
        if (r < ROWS && grid[r][c] === grid[runStart][c] && grid[r][c] !== -1) continue;
        const runLen = r - runStart;
        if (runLen >= 3) {
          const cells = new Set();
          for (let k = runStart; k < r; k++) cells.add(k * COLS + c);
          groups.push({ cells, length: runLen, horizontal: false });
        }
        runStart = r;
      }
    }

    return groups;
  }

  /** Merge groups that share cells (L/T shapes) via iterative flood. */
  function mergeOverlappingGroups(groups) {
    let entries = groups.map(g => ({
      cells: new Set(g.cells),
      maxRunLength: g.length,
      hasH: g.horizontal,
      hasV: !g.horizontal,
    }));

    let didMerge = true;
    while (didMerge) {
      didMerge = false;
      outer:
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          let overlap = false;
          for (const idx of entries[j].cells) {
            if (entries[i].cells.has(idx)) { overlap = true; break; }
          }
          if (overlap) {
            for (const idx of entries[j].cells) entries[i].cells.add(idx);
            entries[i].maxRunLength = Math.max(entries[i].maxRunLength, entries[j].maxRunLength);
            if (entries[j].hasH) entries[i].hasH = true;
            if (entries[j].hasV) entries[i].hasV = true;
            entries.splice(j, 1);
            didMerge = true;
            break outer;
          }
        }
      }
    }

    return entries.map(m => ({
      cells: m.cells,
      totalSize: m.cells.size,
      maxRunLength: m.maxRunLength,
      isLT: m.hasH && m.hasV,
    }));
  }

  /* =========================================================
     VALID-MOVE CHECK & SHUFFLE
     ========================================================= */

  function hasValidMoves() {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (c < COLS - 1) {
          swap(r, c, r, c + 1);
          if (findMatches().size > 0) { swap(r, c, r, c + 1); return true; }
          swap(r, c, r, c + 1);
        }
        if (r < ROWS - 1) {
          swap(r, c, r + 1, c);
          if (findMatches().size > 0) { swap(r, c, r + 1, c); return true; }
          swap(r, c, r + 1, c);
        }
      }
    }
    return false;
  }

  function swap(r1, c1, r2, c2) {
    [grid[r1][c1], grid[r2][c2]] = [grid[r2][c2], grid[r1][c1]];
    [powerUpGrid[r1][c1], powerUpGrid[r2][c2]] = [powerUpGrid[r2][c2], powerUpGrid[r1][c1]];
  }

  function shuffleGrid() {
    const flat = grid.flat();
    for (let i = flat.length - 1; i > 0; i--) {
      const j = rng(i + 1);
      [flat[i], flat[j]] = [flat[j], flat[i]];
    }
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        grid[r][c] = flat[r * COLS + c];

    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        powerUpGrid[r][c] = POWERUP_NONE;

    while (findMatches().size > 0 || !hasValidMoves()) {
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++)
          grid[r][c] = rng(NUM_COLORS);
    }
  }

  /* =========================================================
     SWAP + CASCADE ENGINE
     ========================================================= */

  async function trySwap(r1, c1, r2, c2) {
    isProcessing = true;

    /* animate visual swap */
    await animateSwap(r1, c1, r2, c2);
    swap(r1, c1, r2, c2);
    syncCellEls(r1, c1, r2, c2);

    const matches = findMatches();
    if (matches.size === 0) {
      /* invalid — swap back */
      await animateSwap(r1, c1, r2, c2);
      swap(r1, c1, r2, c2);
      syncCellEls(r1, c1, r2, c2);
      updateCellPositions(false);
      isProcessing = false;
      return;
    }

    await processCascades(r1, c1, r2, c2);
    isProcessing = false;

    if (!gameActive) return;
    if (!hasValidMoves()) {
      shuffleGrid();
      renderGrid();
    }
  }

  /** Keep cellEls[][] in sync after a data swap. */
  function syncCellEls(r1, c1, r2, c2) {
    [cellEls[r1][c1], cellEls[r2][c2]] = [cellEls[r2][c2], cellEls[r1][c1]];
    cellEls[r1][c1].dataset.row = r1; cellEls[r1][c1].dataset.col = c1;
    cellEls[r2][c2].dataset.row = r2; cellEls[r2][c2].dataset.col = c2;
  }

  function updateCellPositions(animate) {
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        positionCell(cellEls[r][c], r, c, animate);
  }

  function animateSwap(r1, c1, r2, c2) {
    return new Promise(resolve => {
      const a = cellEls[r1][c1];
      const b = cellEls[r2][c2];
      const t = `transform ${ANIM.swap}ms ease`;
      a.style.transition = t;
      b.style.transition = t;
      a.style.zIndex = 4;
      b.style.zIndex = 3;
      a.style.transform = `translate(${c2 * cellSize}px, ${r2 * cellSize}px)`;
      b.style.transform = `translate(${c1 * cellSize}px, ${r1 * cellSize}px)`;
      setTimeout(() => {
        a.style.zIndex = '';
        b.style.zIndex = '';
        resolve();
      }, ANIM.swap + 20);
    });
  }

  /* ---------- power-up visual effects ---------- */

  function showBombEffect(r, c) {
    const cx = c * cellSize + cellSize / 2;
    const cy = r * cellSize + cellSize / 2;
    const els = [];

    const ring = document.createElement('div');
    ring.className = 'bomb-ring';
    ring.style.left = cx + 'px';
    ring.style.top  = cy + 'px';
    gridEl.appendChild(ring);
    els.push(ring);

    const flash = document.createElement('div');
    flash.className = 'bomb-flash';
    flash.style.left = cx + 'px';
    flash.style.top  = cy + 'px';
    gridEl.appendChild(flash);
    els.push(flash);

    const count = 14;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'bomb-particle';
      p.style.left = cx + 'px';
      p.style.top  = cy + 'px';
      const angle = (Math.PI * 2 * i / count) + (Math.random() - 0.5) * 0.5;
      const dist  = cellSize * (1.2 + Math.random() * 0.8);
      p.style.setProperty('--dx', Math.cos(angle) * dist + 'px');
      p.style.setProperty('--dy', Math.sin(angle) * dist + 'px');
      p.style.setProperty('--rot', (Math.random() * 720 - 360) + 'deg');
      p.style.animationDelay = (Math.random() * 60) + 'ms';
      gridEl.appendChild(p);
      els.push(p);
    }

    gridEl.classList.add('shake');

    setTimeout(() => {
      els.forEach(e => e.remove());
      gridEl.classList.remove('shake');
    }, ANIM.powerup + 150);
  }

  function showRainbowEffect(r, c) {
    const cx = c * cellSize + cellSize / 2;
    const cy = r * cellSize + cellSize / 2;
    const gridW = COLS * cellSize;
    const gridH = ROWS * cellSize;
    const els = [];

    const hLaser = document.createElement('div');
    hLaser.className = 'rainbow-laser-h';
    hLaser.style.top   = (cy - 18) + 'px';
    hLaser.style.left  = '0';
    hLaser.style.width = gridW + 'px';
    hLaser.style.transformOrigin = (cx / gridW * 100) + '% 50%';
    gridEl.appendChild(hLaser);
    els.push(hLaser);

    const vLaser = document.createElement('div');
    vLaser.className = 'rainbow-laser-v';
    vLaser.style.left  = (cx - 18) + 'px';
    vLaser.style.top   = '0';
    vLaser.style.height = gridH + 'px';
    vLaser.style.transformOrigin = '50% ' + (cy / gridH * 100) + '%';
    gridEl.appendChild(vLaser);
    els.push(vLaser);

    const crossFlash = document.createElement('div');
    crossFlash.className = 'rainbow-cross-flash';
    crossFlash.style.left = cx + 'px';
    crossFlash.style.top  = cy + 'px';
    gridEl.appendChild(crossFlash);
    els.push(crossFlash);

    for (let i = 0; i < COLS; i++) {
      const s = document.createElement('div');
      s.className = 'rainbow-spark';
      s.style.left = (i * cellSize + cellSize / 2) + 'px';
      s.style.top  = cy + 'px';
      s.style.animationDelay = (Math.abs(i - c) * 25) + 'ms';
      gridEl.appendChild(s);
      els.push(s);
    }
    for (let i = 0; i < ROWS; i++) {
      const s = document.createElement('div');
      s.className = 'rainbow-spark';
      s.style.left = cx + 'px';
      s.style.top  = (i * cellSize + cellSize / 2) + 'px';
      s.style.animationDelay = (Math.abs(i - r) * 25) + 'ms';
      gridEl.appendChild(s);
      els.push(s);
    }

    setTimeout(() => els.forEach(e => e.remove()), ANIM.powerup + 150);
  }

  /* ---------- cascade loop ---------- */

  async function processCascades(swapR1, swapC1, swapR2, swapC2) {
    let chain = 0;
    let isFirstRound = true;

    while (gameActive) {
      const groups = findMatchGroups();
      const allMatched = new Set();
      for (const g of groups) for (const idx of g.cells) allMatched.add(idx);
      if (allMatched.size === 0) break;
      chain++;
      playPop(chain);

      /* --- classify matches to earn power-ups --- */
      const merged = mergeOverlappingGroups(groups);
      const pendingPowerUps = [];

      for (const mg of merged) {
        let puType = POWERUP_NONE;
        if (mg.maxRunLength >= 6 || (mg.isLT && mg.totalSize >= 6)) {
          puType = POWERUP_LINE;
        } else if (mg.isLT || mg.maxRunLength >= 4) {
          puType = POWERUP_BOMB;
        }
        if (puType === POWERUP_NONE) continue;

        /* pick a column for the power-up to fall into */
        let spawnCol = -1;
        if (isFirstRound && swapR1 !== undefined) {
          const s1 = swapR1 * COLS + swapC1;
          const s2 = swapR2 * COLS + swapC2;
          if (mg.cells.has(s1)) spawnCol = swapC1;
          else if (mg.cells.has(s2)) spawnCol = swapC2;
        }
        if (spawnCol === -1) {
          const arr = [...mg.cells];
          spawnCol = arr[Math.floor(arr.length / 2)] % COLS;
        }

        pendingPowerUps.push({ type: puType, col: spawnCol });
      }

      /* --- all matched cells are destroyed --- */
      const toDestroy = new Set(allMatched);

      /* --- chain-react: activate power-ups caught in the blast --- */
      const activated = new Set();
      let changed = true;
      while (changed) {
        changed = false;
        for (const idx of toDestroy) {
          if (activated.has(idx)) continue;
          const r = Math.floor(idx / COLS), c = idx % COLS;
          const pu = powerUpGrid[r][c];
          if (pu === POWERUP_NONE) continue;
          activated.add(idx);

          if (pu === POWERUP_BOMB) {
            for (let dr = -1; dr <= 1; dr++) {
              for (let dc = -1; dc <= 1; dc++) {
                const nr = r + dr, nc = c + dc;
                if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
                  const ni = nr * COLS + nc;
                  if (!toDestroy.has(ni)) {
                    toDestroy.add(ni);
                    changed = true;
                  }
                }
              }
            }
          } else if (pu === POWERUP_LINE) {
            for (let cc = 0; cc < COLS; cc++) {
              const ni = r * COLS + cc;
              if (!toDestroy.has(ni)) {
                toDestroy.add(ni);
                changed = true;
              }
            }
            for (let rr = 0; rr < ROWS; rr++) {
              const ni = rr * COLS + c;
              if (!toDestroy.has(ni)) {
                toDestroy.add(ni);
                changed = true;
              }
            }
          }
        }
      }

      /* --- score --- */
      const pts = calcScore(toDestroy, chain);
      score += pts;
      updateHUD();
      showScoreFloats(toDestroy, pts);
      if (chain > 1) showCombo(chain);

      /* --- show power-up activation effects --- */
      let hasActivation = false;
      let playedBomb = false;
      let playedLine = false;
      for (const idx of activated) {
        const r = Math.floor(idx / COLS), c = idx % COLS;
        if (powerUpGrid[r][c] === POWERUP_BOMB) {
          showBombEffect(r, c);
          hasActivation = true;
          if (!playedBomb) {
            playBombSfx();
            playedBomb = true;
          }
        } else if (powerUpGrid[r][c] === POWERUP_LINE) {
          showRainbowEffect(r, c);
          hasActivation = true;
          if (!playedLine) {
            playLineClearSfx();
            playedLine = true;
          }
        }
      }
      if (hasActivation) await delay(ANIM.powerup);

      /* --- pop destroyed cells --- */
      for (const idx of toDestroy) {
        const r = Math.floor(idx / COLS), c = idx % COLS;
        if (cellEls[r] && cellEls[r][c]) cellEls[r][c].classList.add('popping');
      }
      await delay(ANIM.pop);

      /* --- remove from grid --- */
      for (const idx of toDestroy) {
        const r = Math.floor(idx / COLS), c = idx % COLS;
        grid[r][c] = -1;
        powerUpGrid[r][c] = POWERUP_NONE;
        if (cellEls[r] && cellEls[r][c]) {
          cellEls[r][c].remove();
          cellEls[r][c] = null;
        }
      }

      /* --- gravity + fill (power-ups spawn from the top) --- */
      await applyGravityAndFill(pendingPowerUps);
      await delay(ANIM.cascade);

      isFirstRound = false;
    }
  }

  function calcScore(matches, chain) {
    let base = matches.size * 10;
    return Math.round(base * (1 + (chain - 1) * 0.5));
  }

  /* ---------- gravity + fill ---------- */

  async function applyGravityAndFill(pendingPowerUps) {
    pendingPowerUps = pendingPowerUps || [];

    const newGrid   = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
    const newPUGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(POWERUP_NONE));
    const sourceRow = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    const isNew     = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

    /* group pending power-ups by column (one per column max) */
    const puByCol = {};
    for (const pu of pendingPowerUps) {
      puByCol[pu.col] = puByCol[pu.col] || [];
      puByCol[pu.col].push(pu.type);
    }

    function safeFillColor(r, c, g) {
      let avail = [0, 1, 2];
      if (c >= 2 && g[r][c - 1] !== -1 && g[r][c - 1] === g[r][c - 2])
        avail = avail.filter(v => v !== g[r][c - 1]);
      if (r >= 2 && g[r - 1][c] !== -1 && g[r - 1][c] === g[r - 2][c])
        avail = avail.filter(v => v !== g[r - 1][c]);
      if (r >= 1 && r < ROWS - 1 && g[r - 1][c] !== -1 && g[r + 1] && g[r + 1][c] !== -1 && g[r - 1][c] === g[r + 1][c])
        avail = avail.filter(v => v !== g[r - 1][c]);
      return avail[rng(avail.length)];
    }

    for (let c = 0; c < COLS; c++) {
      const pieces = [];
      for (let r = ROWS - 1; r >= 0; r--) {
        if (grid[r][c] !== -1) {
          pieces.push({ color: grid[r][c], pu: powerUpGrid[r][c], fromRow: r, el: cellEls[r][c] });
        }
      }
      pieces.reverse();

      const empty = ROWS - pieces.length;
      const colPUs = puByCol[c] ? puByCol[c].slice() : [];

      /* place surviving pieces first so safeFillColor can see them */
      for (let r = empty; r < ROWS; r++) {
        const p = pieces[r - empty];
        newGrid[r][c] = p.color;
      }

      for (let r = 0; r < ROWS; r++) {
        if (r < empty) {
          newGrid[r][c]    = safeFillColor(r, c, newGrid);
          newPUGrid[r][c]  = colPUs.length > 0 ? colPUs.shift() : POWERUP_NONE;
          sourceRow[r][c]  = -(empty - r);
          isNew[r][c]      = true;
        } else {
          const p = pieces[r - empty];
          newGrid[r][c]    = p.color;
          newPUGrid[r][c]  = p.pu;
          sourceRow[r][c]  = p.fromRow;
          isNew[r][c]      = false;
        }
      }
    }

    grid = newGrid;
    powerUpGrid = newPUGrid;

    /* rebuild DOM: place each piece at source position, then animate to target */
    gridEl.innerHTML = '';
    cellEls = [];

    for (let r = 0; r < ROWS; r++) {
      cellEls[r] = [];
      for (let c = 0; c < COLS; c++) {
        const cell = makeCell(r, c, grid[r][c]);
        /* start at the source row (or above grid for new pieces) */
        positionCell(cell, sourceRow[r][c], c, false);
        gridEl.appendChild(cell);
        cellEls[r][c] = cell;
        if (isNew[r][c]) cell.classList.add('spawning');
      }
    }

    /* force reflow then animate to real positions */
    void gridEl.offsetHeight;

    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        positionCell(cellEls[r][c], r, c, true);

    await delay(ANIM.fall + 60);

    /* clean up spawning class */
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        cellEls[r][c].classList.remove('spawning');
  }

  /* =========================================================
     INPUT (touch + mouse)
     ========================================================= */

  function addInputListeners() {
    gridEl.addEventListener('touchstart', onPointerDown, { passive: false });
    gridEl.addEventListener('touchend',   onPointerUp,   { passive: false });
    gridEl.addEventListener('touchmove',  e => e.preventDefault(), { passive: false });

    gridEl.addEventListener('mousedown', onPointerDown);
    gridEl.addEventListener('mouseup',   onPointerUp);
  }

  function clientXY(e) {
    const t = e.touches && e.touches[0] ? e.touches[0]
            : e.changedTouches          ? e.changedTouches[0]
            : e;
    return { x: t.clientX, y: t.clientY };
  }

  function onPointerDown(e) {
    if (isProcessing || !gameActive) return;
    e.preventDefault();
    unlockAudio();
    pointerDown = true;
    const { x, y } = clientXY(e);
    const rect = gridEl.getBoundingClientRect();
    startX = x;
    startY = y;
    startCol = Math.floor((x - rect.left) / cellSize);
    startRow = Math.floor((y - rect.top)  / cellSize);
    startCol = clamp(startCol, 0, COLS - 1);
    startRow = clamp(startRow, 0, ROWS - 1);
  }

  function onPointerUp(e) {
    if (!pointerDown || isProcessing || !gameActive) return;
    e.preventDefault();
    pointerDown = false;

    const { x, y } = clientXY(e);
    const dx = x - startX;
    const dy = y - startY;
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) return; // tap, not swipe

    let tr = startRow, tc = startCol;
    if (Math.abs(dx) > Math.abs(dy)) {
      tc += dx > 0 ? 1 : -1;
    } else {
      tr += dy > 0 ? 1 : -1;
    }

    if (tr < 0 || tr >= ROWS || tc < 0 || tc >= COLS) return;
    trySwap(startRow, startCol, tr, tc);
  }

  /* =========================================================
     HUD + TIMER
     ========================================================= */

  function updateHUD() {
    $('score-display').textContent = score;
    $('timer-display').textContent = timeLeft;
    const pct = (timeLeft / GAME_TIME) * 100;
    const bar = $('timer-bar');
    bar.style.width = pct + '%';
    bar.classList.toggle('urgent', timeLeft <= 10);
  }

  function startTimer() {
    timerInterval = setInterval(() => {
      timeLeft--;
      updateHUD();
      if (timeLeft <= 0) {
        clearInterval(timerInterval);
        if (gameActive) endGame();
      }
    }, 1000);
  }

  /* =========================================================
     SCORE FLOATS + COMBO
     ========================================================= */

  function showScoreFloats(matches, pts) {
    let sumR = 0, sumC = 0, n = 0;
    for (const idx of matches) {
      sumR += Math.floor(idx / COLS);
      sumC += idx % COLS;
      n++;
    }
    const avgR = sumR / n, avgC = sumC / n;

    const el = document.createElement('div');
    el.className = 'score-float';
    el.textContent = '+' + pts;
    el.style.left = (avgC * cellSize + cellSize / 2) + 'px';
    el.style.top  = (avgR * cellSize) + 'px';
    gridEl.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  function showCombo(chain) {
    const el = $('combo-display');
    el.textContent = chain + 'x COMBO!';
    if (chain % 5 === 0) playComboSfx();
    el.classList.remove('hidden', 'visible');
    void el.offsetHeight;
    el.classList.add('visible');
    setTimeout(() => { el.classList.remove('visible'); el.classList.add('hidden'); }, 900);
  }

  /* =========================================================
     GAME FLOW
     ========================================================= */

  function startGame() {
    clearInterval(timerInterval);
    score = 0;
    timeLeft = GAME_TIME;
    isProcessing = false;
    gameActive = true;
    unlockAudio();
    startBgm();

    initGrid();
    showScreen('screen-gameplay');
    renderGrid();
    updateHUD();
    startTimer();
  }

  function saveScore(name, pts) {
    let leaderboard = JSON.parse(localStorage.getItem('mochiLeaderboard') || '[]');
    leaderboard.push({ name, score: pts });
    leaderboard.sort((a, b) => b.score - a.score);
    leaderboard = leaderboard.slice(0, 5); // Keep top 5
    localStorage.setItem('mochiLeaderboard', JSON.stringify(leaderboard));
    return leaderboard;
  }

  function renderLeaderboard(leaderboard) {
    const list = $('leaderboard-list');
    list.innerHTML = '';
    leaderboard.forEach((entry, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rank">#${i + 1}</span> <span class="name">${entry.name}</span> <span class="score">${entry.score}</span>`;
      list.appendChild(li);
    });
  }

  function endGame() {
    gameActive = false;
    clearInterval(timerInterval);
    stopBgm();
    playEndSfx();

    const rc = $('screen-result').querySelector('.result-content');
    rc.className = 'result-content screen-inner';
    $('result-icon').textContent = '⏱️';
    $('result-score').textContent = 'Score: ' + score;

    $('btn-quit').style.display = 'inline-block';

    const leaderboard = saveScore(playerName, score);
    renderLeaderboard(leaderboard);

    showScreen('screen-result');
  }

  function spawnConfetti() {
    const container = $('result-particles');
    container.innerHTML = '';
    const colours = ['var(--c-yellow)', 'var(--c-pink)', 'var(--c-blue)', '#fff', '#c4b5fd'];
    for (let i = 0; i < 40; i++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      c.style.left = rng(100) + '%';
      c.style.top  = rng(40) + '%';
      c.style.background = colours[rng(colours.length)];
      c.style.animationDelay = (rng(600)) + 'ms';
      c.style.animationDuration = (1200 + rng(800)) + 'ms';
      container.appendChild(c);
    }
  }

  /* =========================================================
     UTILITIES
     ========================================================= */

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  /* =========================================================
     INIT
     ========================================================= */

  function init() {
    gridEl        = $('grid');
    gridContainer = $('grid-container');
    initAudio();
    unlockAudio();
    startBgm();

    addInputListeners();

    const nicknameInput = $('nickname-input');
    const primeBgmFromNickname = () => {
      unlockAudio();
      startBgm();
    };
    nicknameInput.addEventListener('pointerdown', primeBgmFromNickname, { once: true });
    nicknameInput.addEventListener('focus', primeBgmFromNickname, { once: true });

    /* attract (start page) → instructions */
    $('btn-start').addEventListener('click', () => {
      const input = $('nickname-input').value.trim();
      playerName = input !== '' ? input : 'Player';
      unlockAudio();
      startBgm();
      showScreen('screen-instructions');
    });

    /* instructions → play */
    $('screen-instructions').addEventListener('click', () => {
      unlockAudio();
      if (currentScreen === 'screen-instructions') startGame();
    });

    /* result buttons */
    $('btn-play-again').addEventListener('click', (e) => {
      e.stopPropagation();
      unlockAudio();
      startGame();
    });
    $('btn-quit').addEventListener('click', (e) => {
      e.stopPropagation();
      unlockAudio();
      startBgm();
      $('nickname-input').value = '';
      showScreen('screen-attract');
    });

    /* handle resize */
    window.addEventListener('resize', () => {
      if (currentScreen === 'screen-gameplay' && gameActive) {
        renderGrid();
      }
    });

    showScreen('screen-attract');
  }

  /* kick off once DOM is ready */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
