/* =============================================================================
 * TERRA INFINITA — warmode: the player's body under fire
 * -----------------------------------------------------------------------------
 * Health, armour plates, bleeding, suppression, respawn, and the capsule that
 * enemy fire and explosions actually hit (registered as a Combat ray provider,
 * so soldier bullets, shrapnel and vehicle guns all resolve against it).
 * ========================================================================== */
(function () {
  'use strict';
  var U = TERRA.util;

  function Warmode(engine) {
    this.E = engine;
    this.active = true;
    this.health = 100; this.maxHealth = 100;
    this.armor = 60; this.maxArmor = 100;
    this.dead = false; this.deadT = 0;
    this.regenT = 0;
    this.hurt = 0; this.hurtDir = 0; this.hurtPitch = 0;
    this.suppress = 0; this.bleed = 0;
    this.hits = 0; this.kills = 0; this.shotsFired = 0;
    this.respawnT = 0;
    this.hud = { health: 100, armor: 60, dead: false, hurt: 0, suppress: 0 };
    this._provider = null;
  }
  var P = Warmode.prototype;

  P.configure = function (g) {
    this.active = g.combatDetail === undefined ? true : g.combatDetail > 0;
  };

  /** Register with the combat core so bullets can hit the player. */
  P.init = function (combat) {
    var self = this;
    if (self._provider) combat.removeProvider(self._provider);
    self._provider = combat.addProvider(function (o, d, maxT, filter) {
      if (!self.active) return null;
      return self.raycast(o, d, maxT, filter);
    });
  };

  P.raycast = function (o, d, maxT, filter) {
    if (!this.active) return null;
    var E = this.E, C = TERRA.game.Combat, pl = E.player;
    if (filter && filter.skip && filter.skip.indexOf('player') >= 0) return null;
    var crouch = pl.crouch, prone = pl.prone || 0;
    var top = pl.pos[1] + (1.72 - crouch * 0.5 - prone * 1.15);
    var bot = pl.pos[1] + 0.12;
    var r = 0.35;
    var t = C.rayCylinderY(o, d, pl.pos, r, bot, top);
    var headT = C.raySphere(o, d, [pl.pos[0], pl.pos[1] + (1.66 - crouch * 0.48 - prone * 1.1), pl.pos[2]], 0.14);
    var part = 'body', useT = t, surface = 'cloth';
    if (headT !== null && (useT === null || headT < useT)) { useT = headT; part = 'head'; surface = 'skin'; }
    if (useT === null || useT > maxT) return null;
    if (part !== 'head') {
      var ly = (o[1] + d[1] * useT) - pl.pos[1];
      if (this.armor > 0 && ly > 1.0 && ly < 1.6) surface = 'kevlar';
    }
    var n = [-(o[0] + d[0] * useT - pl.pos[0]), 0.1, -(o[2] + d[2] * useT - pl.pos[2])];
    var nl = Math.hypot(n[0], n[2]) || 1; n[0] /= nl; n[2] /= nl;
    return { t: useT, type: 'player', part: part, surface: surface, n: n, head: part === 'head', ref: this };
  };

  /** Take damage. opts: { source, dir, pos, explosive, fall } */
  P.damagePlayer = function (dmg, opts) {
    opts = opts || {};
    if (!this.active || this.dead || dmg <= 0) return { killed: false };
    var E = this.E, C = TERRA.game.Combat.inst;
    // armour eats damage from the plates; headshots bypass half of it
    var head = opts.head;
    var armorAbsorb = head ? this.armor * 0.35 : this.armor;
    var armored = 0;
    if (armorAbsorb > 0) {
      armored = Math.min(dmg * 0.6, armorAbsorb * 0.35);
      this.armor = Math.max(0, this.armor - armored * 1.9);
      dmg -= armored;
    }
    if (opts.explosive) dmg *= 1.1;
    this.health -= dmg;
    this.hits++;
    this.regenT = 0;
    this.hurt = Math.min(1, this.hurt + dmg / 55);
    if (opts.dir) {
      // direction of the threat relative to where the player looks
      var pl = E.player;
      var dx = -opts.dir[0], dz = -opts.dir[2];
      this.hurtDir = Math.atan2(dx, dz) - pl.yaw;
      this.hurtPitch = Math.asin(U.clamp(-opts.dir[1], -1, 1));
    } else if (opts.pos) {
      var pl2 = E.player;
      this.hurtDir = Math.atan2(opts.pos[0] - pl2.pos[0], opts.pos[2] - pl2.pos[2]) - pl2.yaw;
      this.hurtPitch = 0;
    }
    if (C) {
      C.sfx(head ? 'flesh' : 'cloth', E.player.pos, 0.8);
      if (!head) C.sfx('hit', E.player.pos, 0.7);
    }
    if (E.effects) {
      E.effects.shake = Math.max(E.effects.shake || 0, U.clamp(dmg / 60, 0.08, 0.7));
      // blood on the screen edge: a couple of red particles pulled toward the camera
      E.effects.emit(TERRA.game.Effects.K.DUST, [E.player.pos[0], E.player.pos[1] + 1.3, E.player.pos[2]],
        [0, 0.4, 0], 0.35, 0.06, 0.2, [0.5, 0.05, 0.05], 0.5);
    }
    if (this.health <= 0) this.kill(opts);
    this.hudUpdate();
    return { killed: this.dead, hp: this.health };
  };

  P.kill = function (opts) {
    if (this.dead) return;
    var E = this.E;
    this.dead = true; this.deadT = 0; this.health = 0;
    this.respawnT = 3.6;
    this.killedBy = (opts && opts.source && opts.source.cls) || 'hostile fire';
    if (TERRA.ui && TERRA.ui.toast) TERRA.ui.toast('You were killed by ' + this.killedBy, 'warn');
    TERRA.events.emit('playerKilled', { by: opts && opts.source });
  };

  P.respawn = function () {
    var E = this.E, pl = E.player;
    this.dead = false; this.deadT = 0;
    this.health = this.maxHealth; this.armor = Math.max(30, this.armor);
    // wake up near the current spot but away from the firefight
    var spawn = null;
    for (var i = 0; i < 24 && !spawn; i++) {
      var a = Math.random() * Math.PI * 2, r = 90 + Math.random() * 60;
      var x = pl.pos[0] + Math.cos(a) * r, z = pl.pos[2] + Math.sin(a) * r;
      var h = E.groundHeight(x, z), w = E.waterAt(x, z);
      if (w.level > -1e4 && w.type !== 4 && h < w.level + 0.4) continue;
      spawn = [x, h, z];
    }
    if (spawn) pl.teleport(spawn[0], spawn[2], spawn[1] + 0.2);   // player.teleport(x, z, y)
    pl.vel[0] = pl.vel[1] = pl.vel[2] = 0;
    this.hurt = 0; this.bleed = 0;
    // whoever was shooting keeps shooting, but the squad loses track briefly
    var S = E.soldiers;
    if (S) for (var j = 0; j < S.list.length; j++) { S.list[j].lastSeen = null; S.list[j].state = 'patrol'; S.list[j].alertT = 0; }
    if (TERRA.ui && TERRA.ui.toast) TERRA.ui.toast('Back in the fight');
    this.hudUpdate();
  };

  P.heal = function (n) {
    this.health = Math.min(this.maxHealth, this.health + n);
    this.hudUpdate();
  };

  P.addArmor = function (n) {
    this.armor = Math.min(this.maxArmor, this.armor + n);
    this.hudUpdate();
  };

  P.update = function (frame) {
    var dt = frame.dt, pl = this.E.player;
    this.hurt = Math.max(0, this.hurt - dt * 1.6);
    this.suppress = Math.max(0, this.suppress - dt * 0.8);
    if (this.dead) {
      this.deadT += dt;
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.respawn();
      this.hudUpdate();
      return;
    }
    // regeneration: plates and health recover after a pause in the fighting
    this.regenT += dt;
    if (this.regenT > 6.5) {
      if (this.health < this.maxHealth) this.health = Math.min(this.maxHealth, this.health + dt * 3.4);
      if (this.armor < this.maxArmor && this.regenT > 9) this.armor = Math.min(this.maxArmor, this.armor + dt * 4.2);
    }
    // environmental damage: falling is handled by the player controller, deep water/suffocation by the engine
    var sea = (this.E.gen && this.E.gen.SEA !== undefined) ? this.E.gen.SEA : 0;
    if (pl.pos[1] < sea - 3) this.damagePlayer(dt * 8, {});
    this.hudUpdate();
  };

  P.hudUpdate = function () {
    var h = this.hud;
    h.health = this.health; h.armor = this.armor; h.dead = this.dead;
    h.hurt = this.hurt; h.suppress = this.suppress;
    h.hurtDir = this.hurtDir; h.hurtPitch = this.hurtPitch;
  };

  P.serialize = function () {
    return { hp: Math.round(this.health), ar: Math.round(this.armor), dead: this.dead, hits: this.hits, kills: this.kills };
  };
  P.deserialize = function (d) {
    if (!d) return;
    if (d.hp !== undefined) this.health = d.hp;
    if (d.ar !== undefined) this.armor = d.ar;
    if (d.hits !== undefined) this.hits = d.hits;
    if (d.kills !== undefined) this.kills = d.kills;
    this.dead = false;
    this.hudUpdate();
  };

  TERRA.game.Warmode = Warmode;
})();
