// Copyright 2015 by Paulo Augusto Peccin. See license.txt distributed with this file.

// TODO Audio problem in PAL (skipping forward)
// TODO NUSIZ during copy shorten/stretch not implemented
// TODO Re-trigger right displacement is wrong (Meltdown, Beanrider)

jt.Tia = function(pCpu, pPia) {
    "use strict";

    var self = this;

    function init() {
        generateObjectsLineSprites();
        generateObjectsCopiesOffsets();
    }

    this.powerOn = function() {
        jt.Util.arrayFill(linePixels, VBLANK_COLOR);
        jt.Util.arrayFill(debugPixels, 0);
        audioSignal.getChannel0().setVolume(0);
        audioSignal.getChannel1().setVolume(0);
        initLatchesAtPowerOn();
        hMoveLateHit = false;
        changeClock = changeClockPrevLine = -1;
        line = 0;
        audioSignal.signalOn();
        powerOn = true;
    };

    this.powerOff = function() {
        powerOn = false;
        // Let monitors know that the signals are off
        videoSignal.signalOff();
        audioSignal.signalOff();
    };

    this.frame = function() {
        if (debugPause && debugPauseMoreFrames-- <= 0) return;
        do {
            if (debugLevel >= 4) jt.Util.arrayFill(linePixels, 0xff000000);

            // Begin line
            clock = 0;
            renderClock = HBLANK_DURATION; changeClock = -1;
            checkLateHMOVE();
            // Send the first clock/3 pulse to the CPU and PIA, perceived by TIA at clock 0 before releasing halt, then release halt
            bus.clockPulse();
            cpu.setRDY(true);
            for (var x = 0; x < 22; ++x) { clock += 3; bus.clockPulse(); }      // TIA 3..66     CPU 1..22
            updateExtendedHBLANK();
            for (var y = 0; y < 27; ++y) { clock += 3; bus.clockPulse(); }      // TIA 69..147   CPU 23..49
            endObjectsAltStatusMidLine();
            audioSignal.audioClockPulse();
            for (var z = 0; z < 26; ++z) { clock += 3; bus.clockPulse(); }      // TIA 150..225  CPU 50..75
            audioSignal.audioClockPulse();
            finishLine();
        } while(!videoSignal.nextLine(linePixels, vSyncOn));
        // Ask for a refresh of the frame
        audioSignal.finishFrame();
        videoSignal.finishFrame();
    };

    this.connectBus = function(aBus) {
        bus = aBus;
    };

    this.getVideoOutput = function() {
        return videoSignal;
    };

    this.getAudioOutput = function() {
        return audioSignal;
    };

    this.setVideoStandard = function(standard) {
        videoSignal.standard = standard;
        palette = standard === jt.VideoStandard.NTSC ? jt.VideoStandard.NTSC.palette : jt.VideoStandard.PAL.palette;
    };

    this.debug = function(level) {
        debugLevel = level > 4 ? 0 : level;
        debug = debugLevel !== 0;
        videoSignal.showOSD(debug ? "Debug Level " + debugLevel : "Debug OFF", true);
        //cpu.debug = debug;
        pia.debug = debug;
        if (debug) debugSetColors();
        else debugRestoreColors();
    };

    this.read = function(address) {
        switch(address & READ_ADDRESS_MASK) {
            // P0P1, P0M0, P0M1, P0PF,     P0BL, P1M0, P1M1, P1PF,     P1BL, M0M1, M0PF, M0BL,     M1PF, M1BL, PFBL, XXXX
            //  15    14    13    12        11    10    9     8         7     6     5     4         3     2     1     0

            case 0x00: changeAtClock(); return ((collisions & 0x0400) >> 3) | ((collisions & 0x4000) >> 8);          // CXM0P
            case 0x01: changeAtClock(); return ((collisions & 0x2000) >> 6) | ((collisions & 0x0200) >> 3);          // CXM1P
            case 0x02: changeAtClock(); return ((collisions & 0x1000) >> 5) | ((collisions & 0x0800) >> 5);          // CXP0FB
            case 0x03: changeAtClock(); return ((collisions & 0x0100) >> 1) | ((collisions & 0x0080) >> 1);          // CXP1FB
            case 0x04: changeAtClock(); return ((collisions & 0x0020) << 2) | ((collisions & 0x0010) << 2);          // CXM0FB
            case 0x05: changeAtClock(); return ((collisions & 0x0008) << 4) | ((collisions & 0x0004) << 4);          // CXM1FB
            case 0x06: changeAtClock(); return ((collisions & 0x0002) << 6);                                         // CXBLPF
            case 0x07: changeAtClock(); return ((collisions & 0x8000) >> 8) | (collisions & 0x0040);                 // CXPPMM

            case 0x08: return INPT0;
            case 0x09: return INPT1;
            case 0x0A: return INPT2;
            case 0x0B: return INPT3;
            case 0x0C: return INPT4;
            case 0x0D: return INPT5;
            default:   return 0;
        }
    };

    this.write = function(address, i) {
        switch (address & WRITE_ADDRESS_MASK) {
            // VSync, VBlank and HSync
            case 0x00: vSyncSet(i); return;
            case 0x01: vBlankSet(i); return;
            case 0x02: cpu.setRDY(false); if (debug) debugPixel(DEBUG_WSYNC_COLOR); return; 	       // <STROBE> Halts the CPU until the next HBLANK

            // Playfield
            case 0x09: if (COLUBK !== i && !debug) { changeAtClock(); COLUBK = i; playfieldBackground = palette[i]; } return;
            case 0x0D: if (PF0 !== (i & 0xf0)) { changePlayfieldAtClock(); PF0 = i & 0xf0; playfieldUpdateSprite(); } return;
            case 0x0E: if (PF1 !== i) { changePlayfieldAtClock(); PF1 = i; playfieldUpdateSprite(); } return;
            case 0x0F: if (PF2 !== i) { changePlayfieldAtClock(); PF2 = i; playfieldUpdateSprite(); } return;

            // Playfield & Ball
            case 0x08: if (COLUPF !== i && !debug) { if ((playfieldEnabled && !playfieldScoreMode) || ballEnabled) changeAtClock(); COLUPF = i; ballColor = palette[i]; if (!playfieldScoreMode) playfieldLeftColor = playfieldRightColor = ballColor } return;
            case 0x0A: if (CTRLPF !== i) { playfieldSetShape(i); } return;

            // Ball
            case 0x14: hitRESBL(); return;
            case 0x1F: if (ENABLd !== (i & 0x02)) { ENABLd = i & 0x02; if (!VDELBL) { changeAtClock(); ballSetEnabled(ENABLd); } } return;
            case 0x27: if (VDELBL !== (i  & 1)) { VDELBL = i & 1; if (ENABL !== ENABLd) { changeAtClock(); ballSetEnabled(VDELBL ? ENABL : ENABLd); } } return;

            // Player0
            case 0x04: player0SetShape(i); return;
            case 0x06: if (COLUP0 !== i && !debug) { COLUP0 = i; if (player0Enabled || missile0Enabled || (playfieldEnabled && playfieldScoreMode)) changeAtClock(); player0Color = missile0Color = palette[i]; if (playfieldScoreMode) playfieldLeftColor = player0Color; } return;
            case 0x0B: if (REFP0 !== ((i >> 3) & 1)) { REFP0 = (i >> 3) & 1; player0UpdateSprite(0); } return;
            case 0x10: hitRESP0(); return;
            case 0x1B: player0SetSprite(i); return;
            case 0x25: if (VDELP0 !== (i  & 1)) { VDELP0 = i & 1; if (GRP0 !== GRP0d) player0UpdateSprite(0); } return;

            // Player1
            case 0x05: player1SetShape(i); return;
            case 0x07: if (COLUP1 !== i && !debug) { COLUP1 = i; if (player1Enabled || missile1Enabled || (playfieldEnabled && playfieldScoreMode)) changeAtClock(); player1Color = missile1Color = palette[i]; if (playfieldScoreMode) playfieldRightColor = player1Color; } return;
            case 0x0C: if (REFP1 !== ((i >> 3) & 1)) { REFP1 = (i >> 3) & 1; player1UpdateSprite(0); } return;
            case 0x11: hitRESP1(); return;
            case 0x1C: player1SetSprite(i); return;
            case 0x26: if (VDELP1 !== (i  & 1)) { VDELP1 = i & 1; if (GRP1 !== GRP1d) player1UpdateSprite(0); } return;

            // Missile0
            case 0x12: hitRESM0(); return;
            case 0x1D: if (ENAM0 !== (i & 0x02)) { ENAM0 = i & 0x02; if (!RESMP0) { changeAtClock(); missile0SetEnabled(ENAM0); } } return;
            case 0x28: missile0SetResetToPlayer(i); return;

            // Missile1
            case 0x13: hitRESM1(); return;
            case 0x1E: if (ENAM1 !== (i & 0x02)) { ENAM1 = i & 0x02; if (!RESMP1) { changeAtClock(); missile1SetEnabled(ENAM1); } } return;
            case 0x29: missile1SetResetToPlayer(i); return;

            // HMOVE
            case 0x20: HMP0 = (i > 127 ? -16 : 0) + (i >> 4); return;
            case 0x21: HMP1 = (i > 127 ? -16 : 0) + (i >> 4); return;
            case 0x22: HMM0 = (i > 127 ? -16 : 0) + (i >> 4); return;
            case 0x23: HMM1 = (i > 127 ? -16 : 0) + (i >> 4); return;
            case 0x24: HMBL = (i > 127 ? -16 : 0) + (i >> 4); return;
            case 0x2A: hitHMOVE(); return;
            case 0x2B: HMP0 = HMP1 = HMM0 = HMM1 = HMBL = 0; return;

            // Collisions
            case 0x2C: changeAtClock(); collisions = 0; return;

            // RSYNC
            //case 0x03: clock = 0; return;

            // Audio
            case 0x15: if (AUDC0 !== i) { AUDC0 = i; audioSignal.getChannel0().setControl(i & 0x0f); } return;
            case 0x16: if (AUDC1 !== i) { AUDC1 = i; audioSignal.getChannel1().setControl(i & 0x0f); } return;
            case 0x17: if (AUDF0 !== i) { AUDF0 = i; audioSignal.getChannel0().setDivider((i & 0x1f) + 1); } return;     // Bits 0-4, Divider from 1 to 32
            case 0x18: if (AUDF1 !== i) { AUDF1 = i; audioSignal.getChannel1().setDivider((i & 0x1f) + 1); } return;
            case 0x19: if (AUDV0 !== i) { AUDV0 = i; audioSignal.getChannel0().setVolume(i & 0x0f); } return;            // Bits 0-3, Volume from 0 to 15
            case 0x1A: if (AUDV1 !== i) { AUDV1 = i; audioSignal.getChannel1().setVolume(i & 0x0f); } return;
        }
    };

    // caution: endClock can exceed but never wrap end of line!
    function renderLineTo(endClock) {
        var p, linePixel = renderClock, finalPixel = (endClock > LINE_WIDTH ? LINE_WIDTH : endClock) - HBLANK_DURATION;

        for (var pixel = linePixel - HBLANK_DURATION; pixel < finalPixel; ++pixel) {

            if (vBlankOn) { linePixels[linePixel] = vBlankColor; ++linePixel; continue }

            // Pixel color and Flags for Collision latches
            var color = 0, collis = collisionsPossible;

            if (playfieldPriority) {
                // Ball
                if (ballEnabled) {
                    p = pixel - ballPixel; if (p < 0) p += 160;
                    if ((missileBallLineSprites[ballLineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                        color = ballColor;
                    } else collis &= BLC;
                }
                // Playfield
                if (playfieldEnabled) {
                    if (pixel < 80) {
                        if ((playfieldPatternL >> (pixel >> 2)) & 1) {
                            if (!color) color = playfieldLeftColor;
                        } else collis &= PFC;
                    } else {
                        if ((playfieldPatternR >> ((pixel - 80) >> 2)) & 1) {
                            if (!color) color = playfieldRightColor;
                        } else collis &= PFC;
                    }
                }
            }

            // Player0
            if (player0Enabled) {
                p = pixel - player0Pixel; if (p < 0) p += 160;
                if ((playerLineSprites[player0LineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                    if (!color) color = player0Color;
                } else collis &= P0C;
            }

            // Missile0
            if (missile0Enabled) {
                p = pixel - missile0Pixel; if (p < 0) p += 160;
                if ((missileBallLineSprites[missile0LineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                    if (!color) color = missile0Color;
                } else collis &= M0C;
            }

            // Player1
            if (player1Enabled) {
                p = pixel - player1Pixel; if (p < 0) p += 160;
                if ((playerLineSprites[player1LineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                    if (!color) color = player1Color;
                } else collis &= P1C;
            }

            // Missile1
            if (missile1Enabled) {
                p = pixel - missile1Pixel; if (p < 0) p += 160;
                if ((missileBallLineSprites[missile1LineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                    if (!color) color = missile1Color;
                } else collis &= M1C;
            }

            if (!playfieldPriority) {
                // Ball
                if (ballEnabled) {
                    p = pixel - ballPixel; if (p < 0) p += 160;
                    if ((missileBallLineSprites[ballLineSpritePointer + (p >> 3)] >> (p & 0x07)) & 1) {
                        if (!color) color = ballColor;
                    } else collis &= BLC;
                }
                // Playfield
                if (playfieldEnabled) {
                    if (pixel < 80) {
                        if ((playfieldPatternL >> (pixel >> 2)) & 1) {
                            if (!color) color = playfieldLeftColor;
                        } else collis &= PFC;
                    } else {
                        if ((playfieldPatternR >> ((pixel - 80) >> 2)) & 1) {
                            if (!color) color = playfieldRightColor;
                        } else collis &= PFC;
                    }
                }
            }

            // Set pixel color, or background
            linePixels[linePixel] = color || playfieldBackground;
            ++linePixel;

            // Update collision latches
            if (!debugNoCollisions) collisions |= collis;
        }
    }

    function changeAt(atClock) {
        if (vBlankOn) return;

        if (atClock > renderClock) {
            if (changeClock >= 0 || changeClockPrevLine >= 0) renderLineTo(atClock);
            renderClock = atClock;
        }
        changeClock = renderClock;
    }

    function changeAtClock() {
        changeAt(clock);
    }

    function changeAtClockPlus(add) {
        changeAt(clock + add);                      // Renders "add" pixels forward, for changes that are only effective after "add" clocks
    }

    function changePlayfieldAtClock() {
        if (debug) debugPixel(DEBUG_PF_GR_COLOR);
        // PF changes are only effective after 2 clocks. Additionally, once a playfield pixel (4 clocks wide) has started,
        // it will remain the same until the end. So we will perceive this change accordingly
        if (clock < renderClock - 1) return changeAtClock();         // Does not matter
        var ip = clock & 0x03;
        if (ip < 3) changeAtClockPlus(4 - ip);      // Perceive change only at the next PF pixel
        else changeAtClockPlus(5);                  // Perceive change only 2 PF pixels later
    }

    function changeVBlankAtClockPlus1() {
        var atClock = clock + 1;
        if (atClock > renderClock) {
            if (changeClock >= 0 || changeClockPrevLine >= 0) renderLineTo(atClock);
            renderClock = atClock;
        }
        changeClock = renderClock;
    }

    var finishLine = function() {
        // Render remaining part of current line if needed
        if (changeClock >= 0) {
            renderLineTo(LINE_WIDTH);
            changeClockPrevLine = changeClock;
        } else {
            if (changeClockPrevLine >= 0) {
                renderLineTo(changeClockPrevLine);
                changeClockPrevLine = -1;
            }
        }
        // Disabled repeat mode
        //renderLineTo(LINE_WIDTH);
        //changeClockPrevLine = 0;

        endObjectsAltStatusEndOfLine();

        // Handle Paddles capacitor charging, only if paddles are connected (position >= 0)
        if (paddle0Position >= 0 && !paddleCapacitorsGrounded) {
            if (INPT0 < 0x80 && ++paddle0CapacitorCharge >= paddle0Position) INPT0 |= 0x80;
            if (INPT1 < 0x80 && ++paddle1CapacitorCharge >= paddle1Position) INPT1 |= 0x80;
        }

        // Inject debugging information in the line if needed
        if (debugLevel >= 1) processDebugPixelsInLine();

        ++line;
    };

    function augmentCollisionsPossible() {
        collisionsPossible = 0xfffe;
        if (!player0Enabled) collisionsPossible &= P0C;
        if (!player1Enabled) collisionsPossible &= P1C;
        if (!missile0Enabled) collisionsPossible &= M0C;
        if (!missile1Enabled) collisionsPossible &= M1C;
        if (!playfieldEnabled) collisionsPossible &= PFC;
        if (!ballEnabled) collisionsPossible &= BLC;
    }

    var playfieldSetShape = function(i) {
        if (CTRLPF === i) return;

        var v = i & 0x07;
        if (v !== (CTRLPF & 0x07)) {
            if (playfieldEnabled) changeAtClock();

            v = (i & 0x01) !== 0;
            if (playfieldReflected !== v) {
                playfieldReflected = v;
                playfieldUpdateSpriteR();
            }

            v = (i & 0x02) !== 0;
            if (playfieldScoreMode !== v) {
                playfieldScoreMode = v;
                if (v) { playfieldLeftColor = player0Color; playfieldRightColor = player1Color }
                else playfieldLeftColor = playfieldRightColor = palette[COLUPF];
            }

            playfieldPriority = (i & 0x04) !== 0;
        }

        v = i & 0x30;
        if (v !== (CTRLPF & 0x30)) {
            if (ballEnabled) changeAtClock();
            ballLineSpritePointer = (v >> 1) << 6;
        }

        CTRLPF = i;
    };

    function playfieldUpdateSprite() {
        playfieldPatternL = (PF2 << 12) | (jt.Util.reverseInt8(PF1) << 4) | ((PF0 & 0xf0) >> 4);
        playfieldUpdateSpriteR();
    }

    function playfieldUpdateSpriteR() {
        playfieldPatternR = playfieldReflected ? (jt.Util.reverseInt8(PF0) << 16) | (PF1 << 8) | jt.Util.reverseInt8(PF2) : playfieldPatternL;
        if (playfieldPatternL !== 0 || playfieldPatternR !== 0) {
            playfieldEnabled = true; augmentCollisionsPossible();
        } else {
            playfieldEnabled = false; collisionsPossible &= PFC;
        }
    }

    function ballSetEnabled(boo) {
        if (boo) {
            ballEnabled = true; augmentCollisionsPossible();
        } else {
            ballEnabled = false; collisionsPossible &= BLC;
        }
    }

    function player0SetShape(i) {
        if (NUSIZ0 === i) return;

        var dif = NUSIZ0 ^ i;
        var oldNUSIZ0 = NUSIZ0;
        NUSIZ0 = i;

        if (dif & 0x07) {
            // Enter Alt mode?

            //if (debug) debugPixel(DEBUG_ALT_COLOR);

            if (!player0Alt) {
                var into = (clock < HBLANK_DURATION ? 0 : clock - HBLANK_DURATION ) - player0Pixel; if (into < 0) into += 160;
                var oldOffset = playerCopiesOffsets[(oldNUSIZ0 & 7) * 160 + into];
                var newOffset = playerCopiesOffsets[(i & 7) * 160 + into];
                if (newOffset !== oldOffset) {
                    if (player0Enabled) changeAtClock();
                    player0Alt = player0Pixel >= 80 ? 1 : 2; player0LineSpritePointer -= 20;
                    player0AltFrom = into;
                    player0AltLength = playerCopyLengthPerShape[i & 7] - (newOffset & 0x3f);
                    player0AltCopyOffset = oldOffset;
                }
            }
            player0UpdateSprite(0);
        }

        if (dif & 0x37) {
            // Enter Alt mode?
            if (!missile0Alt) {
                into = (clock < HBLANK_DURATION ? 0 : clock - HBLANK_DURATION ) - missile0Pixel; if (into < 0) into += 160;
                oldOffset = missileCopiesOffsets[(((oldNUSIZ0 & 0x30) >> 1) | (oldNUSIZ0 & 7)) * 160 + into];
                newOffset = missileCopiesOffsets[(((i & 0x30) >> 1) | (i & 7)) * 160 + into];
                if (newOffset !== oldOffset) {
                    if (missile0Enabled) changeAtClock();
                    missile0Alt = missile0Pixel >= 80 ? 1 : 2; missile0LineSpritePointer -= 20;
                    missile0AltFrom = into;
                    missile0AltLength = missileCopyLengthPerSize[(i & 0x30) >> 4] - (newOffset & 0x3f);
                    missile0AltCopyOffset = oldOffset;
                }
            }
            missile0UpdateSprite();
        }
    }

    function player0SetSprite(i) {
        if (debug) debugPixel(DEBUG_P0_GR_COLOR);
        if (GRP0d !== i) {
            GRP0d = i;
            if (!VDELP0) player0UpdateSprite(1);
        }
        if (GRP1 !== GRP1d) {
            GRP1 = GRP1d;
            if (VDELP1) player1UpdateSprite(1);
        }
    }

    function player0UpdateSprite(clockPlus) {
        var sprite = VDELP0 ? GRP0 : GRP0d;
        if (sprite) {
            var p = (((REFP0 << 11) | (sprite << 3) | (NUSIZ0 & 7)) << 6) + (player0Alt ? 20 : 0);
            if (!player0Enabled || player0LineSpritePointer !== p) {
                changeAtClockPlus(clockPlus);
                player0LineSpritePointer = p;
                if (player0Alt) player0DefineAlt();
            }
            if (!player0Enabled) {
                player0Enabled = true; augmentCollisionsPossible();
            }
        } else {
            if (player0Enabled) {
                changeAtClockPlus(clockPlus);
                player0Enabled = false; collisionsPossible &= P0C;
            }
        }
    }

    function player1SetShape(i) {
        if (NUSIZ1 === i) return;

        var dif = NUSIZ1 ^ i;
        var oldNUSIZ1 = NUSIZ1;
        NUSIZ1 = i;

        if (dif & 0x07) {

            //if (debug) debugPixel(DEBUG_ALT_COLOR);

            // Enter Alt mode?
            if (!player1Alt) {
                var into = (clock < HBLANK_DURATION ? 0 : clock - HBLANK_DURATION ) - player1Pixel; if (into < 0) into += 160;
                var oldOffset = playerCopiesOffsets[(oldNUSIZ1 & 7) * 160 + into];
                var newOffset = playerCopiesOffsets[(i & 7) * 160 + into];
                if (newOffset !== oldOffset) {
                    if (player1Enabled) changeAtClock();
                    player1Alt = player1Pixel >= 80 ? 1 : 2; player1LineSpritePointer -= 40;
                    player1AltFrom = into;
                    player1AltLength = playerCopyLengthPerShape[i & 7] - (newOffset & 0x3f);
                    player1AltCopyOffset = oldOffset;
                }

                //if (debug) debugInfo("OldOffset: " + oldOffset + ", NewOffset: " + newOffset + ", player1Alt: " + player1Alt);

            }
            player1UpdateSprite(0);
        }

        if (dif & 0x37) {
            // Enter Alt mode?
            if (!missile1Alt) {
                into = (clock < HBLANK_DURATION ? 0 : clock - HBLANK_DURATION ) - missile1Pixel; if (into < 0) into += 160;
                oldOffset = missileCopiesOffsets[(((oldNUSIZ1 & 0x30) >> 1) | (oldNUSIZ1 & 7)) * 160 + into];
                newOffset = missileCopiesOffsets[(((i & 0x30) >> 1) | (i & 7)) * 160 + into];
                if (newOffset !== oldOffset) {
                    if (missile1Enabled) changeAtClock();
                    missile1Alt = missile1Pixel >= 80 ? 1 : 2; missile1LineSpritePointer -= 40;
                    missile1AltFrom = into;
                    missile1AltLength = missileCopyLengthPerSize[(i & 0x30) >> 4] - (newOffset & 0x3f);
                    missile1AltCopyOffset = oldOffset;
                }
            }
            missile1UpdateSprite();
        }
    }

    function player1SetSprite(i) {
        if (debug) debugPixel(DEBUG_P1_GR_COLOR);
        if (GRP1d !== i) {
            GRP1d = i;
            if (!VDELP1) player1UpdateSprite(1);
        }
        if (GRP0 !== GRP0d) {
            GRP0 = GRP0d;
            if (VDELP0) player0UpdateSprite(1);
        }
        if (ENABL !== ENABLd) {
            ENABL = ENABLd;
            if (VDELBL) changeAtClockPlus(1);
            ballSetEnabled(ENABL);
        }
    }

    function player1UpdateSprite(clockPlus) {
        var sprite = VDELP1 ? GRP1 : GRP1d;
        if (sprite) {
            var p = (((REFP1 << 11) | (sprite << 3) | (NUSIZ1 & 7)) << 6) + (player1Alt ? 40 : 0);
            if (!player1Enabled || player1LineSpritePointer !== p) {
                changeAtClockPlus(clockPlus);
                player1LineSpritePointer = p;
                if (player1Alt) player1DefineAlt();
            }
            if (!player1Enabled) {
                player1Enabled = true; augmentCollisionsPossible();
            }
        } else {
            if (player1Enabled) {
                changeAtClockPlus(clockPlus);
                player1Enabled = false; collisionsPossible &= P1C;
            }
        }
    }

    function missile0UpdateSprite() {
        var p = ((((NUSIZ0 & 0x30) >> 1) | (NUSIZ0 & 7)) << 6) + (missile0Alt ? 20 : 0);
        if (missile0LineSpritePointer !== p) {
            if (missile0Enabled) {
                changeAtClock();
                missile0LineSpritePointer = p;
                if (missile0Alt) missile0DefineAlt();
            } else
                missile0LineSpritePointer = p;
        }
    }

    function missile0SetEnabled(boo) {
        if (boo) {
            missile0Enabled = true; augmentCollisionsPossible();
            if (missile0Alt) missile0DefineAlt();
        } else {
            missile0Enabled = false; collisionsPossible &= M0C;
        }
    }

    function missile0SetResetToPlayer(i) {
        if (RESMP0 === (i & 0x02)) return;

        if (ENAM0) {
            changeAtClock();
            missile0SetEnabled(!(RESMP0 = i & 0x02));
        } else
            RESMP0 = i & 0x02;

        if (!RESMP0) {
            missile0Pixel = player0Pixel + missileCenterOffsetsPerPlayerSize[NUSIZ0 & 0x07]; if (missile0Pixel >= 160) missile0Pixel -= 160;
        }
    }

    function missile1UpdateSprite() {
        var p = ((((NUSIZ1 & 0x30) >> 1) | (NUSIZ1 & 7)) << 6) + (missile1Alt ? 40 : 0);
        if (missile1LineSpritePointer !== p) {
            if (missile1Enabled) {
                changeAtClock();
                missile1LineSpritePointer = p;
                if (missile1Alt) missile1DefineAlt();
            } else
                missile1LineSpritePointer = p;
        }
    }

    function missile1SetEnabled(boo) {
        if (boo) {
            missile1Enabled = true; augmentCollisionsPossible();
            if (missile1Alt) missile1DefineAlt();
        } else {
            missile1Enabled = false; collisionsPossible &= M1C;
        }
    }

    function missile1SetResetToPlayer(i) {
        if (RESMP1 === (i & 0x02)) return;

        if (ENAM1) {
            changeAtClock();
            missile1SetEnabled(!(RESMP1 = i & 0x02));
        } else
            RESMP1 = i & 0x02;

        if (!RESMP1) {
            missile1Pixel = player1Pixel + missileCenterOffsetsPerPlayerSize[NUSIZ1 & 0x07]; if (missile1Pixel >= 160) missile1Pixel -= 160;
        }
    }

    var hitRESP0 = function() {
        if (debug) debugPixel(DEBUG_P0_RES_COLOR);

        var p = getRESxPixel();
        if (player0Pixel !== p) {
            if (player0Enabled) changeAtClock();
            if (!player0Alt) { player0LineSpritePointer += 20; }
            player0Alt = p >= 80 ? 1 : 2;
            var into = p - player0Pixel; if (into < 0) into += 160;
            player0Pixel = p;
            var nusiz = (NUSIZ0 & 7);
            player0AltFrom = 0;
            player0AltLength = playerCopyLengthPerShape[nusiz];
            player0AltCopyOffset = playerCopiesOffsets[nusiz * 160 + into] & 0xbf;
            if (player0Enabled) player0DefineAlt();
        }

        //player0Counter = 157 - d;
        //player0RecentReset = player0Counter <= 155;
    };

    function player0DefineAlt() {
        var control = (player0AltFrom << 16) | (player0AltLength << 8) | player0AltCopyOffset;
        var controlPointer = (player0LineSpritePointer - 20) >> 6;
        if (player0AltControl[controlPointer] === control) return;

        var basePointer = player0LineSpritePointer - 20;
        for (var b = (player0AltFrom + player0AltLength) >> 3; b < 14; ++b) playerLineSprites[player0LineSpritePointer + b] = playerLineSprites[basePointer + b];

        if (player0AltCopyOffset & 0xc0) {
            // Just clear bits
            for (var p = player0AltFrom, to = player0AltFrom + player0AltLength; p < to; ++p)
                playerLineSprites[player0LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        } else {
            // Copy bits from base
            var pBase = player0AltCopyOffset & 0x3f;
            basePointer -= objectsLineSpritePointerDeltaToSingleCopy[(NUSIZ0 & 7)];
            for (p = player0AltFrom, to = player0AltFrom + player0AltLength; p < to; ++p, ++pBase)
                if ((playerLineSprites[basePointer + (pBase >> 3)] >> (pBase & 0x07)) & 1)
                    playerLineSprites[player0LineSpritePointer + (p >> 3)] |= (1 << (p & 0x07));
                else
                    playerLineSprites[player0LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        }

        player0AltControl[controlPointer] = control;
    }

    var hitRESP1 = function() {
        if (debug) debugPixel(DEBUG_P1_RES_COLOR);

        var p = getRESxPixel();
        if (player1Pixel !== p) {
            if (player1Enabled) changeAtClock();
            if (!player1Alt) { player1LineSpritePointer += 40; }
            player1Alt = p >= 80 ? 1 : 2;
            var into = p - player1Pixel; if (into < 0) into += 160;
            player1Pixel = p;
            var nusiz = NUSIZ1 & 7;
            player1AltFrom = 0;
            player1AltLength = playerCopyLengthPerShape[nusiz];
            player1AltCopyOffset = playerCopiesOffsets[nusiz * 160 + into] & 0xbf;
            if (player1Enabled) player1DefineAlt();
        }
    };

    function player1DefineAlt() {
        var control = (player1AltFrom << 16) | (player1AltLength << 8) | player1AltCopyOffset;
        var controlPointer = (player1LineSpritePointer - 40) >> 6;
        if (player1AltControl[controlPointer] === control) return;

        var basePointer = player1LineSpritePointer - 40;
        for (var b = (player1AltFrom + player1AltLength) >> 3; b < 14; ++b) playerLineSprites[player1LineSpritePointer + b] = playerLineSprites[basePointer + b];

        if (player1AltCopyOffset & 0xc0) {
            // Just clear bits
            for (var p = player1AltFrom, to = player1AltFrom + player1AltLength; p < to; ++p)
                playerLineSprites[player1LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        } else {
            // Copy bits from base
            var pBase = player1AltCopyOffset & 0x3f;
            basePointer -= objectsLineSpritePointerDeltaToSingleCopy[(NUSIZ1 & 7)];
            for (p = player1AltFrom, to = player1AltFrom + player1AltLength; p < to; ++p, ++pBase)
                if ((playerLineSprites[basePointer + (pBase >> 3)] >> (pBase & 0x07)) & 1)
                    playerLineSprites[player1LineSpritePointer + (p >> 3)] |= (1 << (p & 0x07));
                else
                    playerLineSprites[player1LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        }

        player1AltControl[controlPointer] = control;
    }

    var hitRESM0 = function() {
        if (debug) debugPixel(DEBUG_M0_COLOR);

        var p = getRESxPixel();
        if (missile0Pixel !== p) {
            if (missile0Enabled) changeAtClock();
            if (!missile0Alt) { missile0LineSpritePointer += 20; }
            missile0Alt = p >= 80 ? 1 : 2;
            var into = p - missile0Pixel; if (into < 0) into += 160;
            missile0Pixel = p;
            missile0AltFrom = 0;
            missile0AltLength = missileCopyLengthPerSize[(NUSIZ0 & 0x30) >> 4];
            missile0AltCopyOffset = missileCopiesOffsets[(((NUSIZ0 & 0x30) >> 1) | (NUSIZ0 & 7)) * 160 + into] & 0xbf;
            if (missile0Enabled) missile0DefineAlt();
        }
    };

    function missile0DefineAlt() {
        var control = (missile0AltFrom << 16) | (missile0AltLength << 8) | missile0AltCopyOffset;
        var controlPointer = (missile0LineSpritePointer - 20) >> 6;
        if (missile0AltControl[controlPointer] === control) return;

        var basePointer = missile0LineSpritePointer - 20;
        for (var b = (missile0AltFrom + missile0AltLength) >> 3; b < 14; ++b) missileBallLineSprites[missile0LineSpritePointer + b] = missileBallLineSprites[basePointer + b];

        if (missile0AltCopyOffset & 0xc0) {
            // Just clear bits
            for (var p = missile0AltFrom, to = missile0AltFrom + missile0AltLength; p < to; ++p)
                missileBallLineSprites[missile0LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        } else {
            // Copy bits from base
            var pBase = missile0AltCopyOffset & 0x3f;
            basePointer -= objectsLineSpritePointerDeltaToSingleCopy[(NUSIZ0 & 7)];
            for (p = missile0AltFrom, to = missile0AltFrom + missile0AltLength; p < to; ++p, ++pBase)
                if ((missileBallLineSprites[basePointer + (pBase >> 3)] >> (pBase & 0x07)) & 1)
                    missileBallLineSprites[missile0LineSpritePointer + (p >> 3)] |= (1 << (p & 0x07));
                else
                    missileBallLineSprites[missile0LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        }

        missile0AltControl[controlPointer] = control;
    }

    var hitRESM1 = function() {
        if (debug) debugPixel(DEBUG_M1_COLOR);
        var p = getRESxPixel();
        if (missile1Pixel !== p) {
            if (missile1Enabled) changeAtClock();
            if (!missile1Alt) { missile1LineSpritePointer += 40; }
            missile1Alt = p >= 80 ? 1 : 2;
            var into = p - missile1Pixel; if (into < 0) into += 160;
            missile1Pixel = p;
            missile1AltFrom = 0;
            missile1AltLength = missileCopyLengthPerSize[(NUSIZ1 & 0x30) >> 4];
            missile1AltCopyOffset = missileCopiesOffsets[(((NUSIZ1 & 0x30) >> 1) | (NUSIZ1 & 7)) * 160 + into] & 0xbf;
            if (missile1Enabled) missile1DefineAlt();
        }
    };

    function missile1DefineAlt() {
        var control = (missile1AltFrom << 16) | (missile1AltLength << 8) | missile1AltCopyOffset;
        var controlPointer = (missile1LineSpritePointer - 40) >> 6;
        if (missile1AltControl[controlPointer] === control) return;

        var basePointer = missile1LineSpritePointer - 40;
        for (var b = (missile1AltFrom + missile1AltLength) >> 3; b < 14; ++b) missileBallLineSprites[missile1LineSpritePointer + b] = missileBallLineSprites[basePointer + b];

        if (missile1AltCopyOffset & 0xc0) {
            // Just clear bits
            for (var p = missile1AltFrom, to = missile1AltFrom + missile1AltLength; p < to; ++p)
                missileBallLineSprites[missile1LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        } else {
            // Copy bits from base
            var pBase = missile1AltCopyOffset & 0x3f;
            basePointer -= objectsLineSpritePointerDeltaToSingleCopy[(NUSIZ1 & 7)];
            for (p = missile1AltFrom, to = missile1AltFrom + missile1AltLength; p < to; ++p, ++pBase)
                if ((missileBallLineSprites[basePointer + (pBase >> 3)] >> (pBase & 0x07)) & 1)
                    missileBallLineSprites[missile1LineSpritePointer + (p >> 3)] |= (1 << (p & 0x07));
                else
                    missileBallLineSprites[missile1LineSpritePointer + (p >> 3)] &= ~(1 << (p & 0x07));
        }

        missile1AltControl[controlPointer] = control;
    }

    var hitRESBL = function() {
        if (debug) debugPixel(DEBUG_BL_COLOR);

        var p = getRESxPixel();
        if (ballPixel !== p) {
            if (ballEnabled) changeAtClock();
            ballPixel = p;
        }
    };

    var hitHMOVE = function() {
        if (debug) debugPixel(DEBUG_HMOVE_COLOR);
        // Normal HMOVE
        if (clock < HBLANK_DURATION) {
            hMoveHitClock = clock;
            hMoveHitBlank = true;
            performHMOVE();
            return;
        }
        // Unsupported HMOVE
        if (clock < 219) {
            // debugInfo("Unsupported HMOVE hit");
            return;
        }
        // Late HMOVE: Clocks [219-224] hide HMOVE blank next line, clocks [225, 0] produce normal behavior next line
        // debugInfo("Late HMOVE hit");
        hMoveHitClock = 160 - clock;
        hMoveLateHit = true;
        hMoveLateHitBlank = clock >= 225;
    };

    // Can only be called during HBLANK!
    var performHMOVE = function() {
        // Change objects position
        var add;
        var changed = false;
        add = (hMoveHitBlank ? HMP0 : HMP0 + 8); if (add !== 0) {
            player0Pixel -= add; if (player0Pixel >= 160) player0Pixel -= 160; else if (player0Pixel < 0) player0Pixel += 160;
            if (player0Enabled) changed = true;
        }
        add = (hMoveHitBlank ? HMP1 : HMP1 + 8); if (add !== 0) {
            player1Pixel -= add; if (player1Pixel >= 160) player1Pixel -= 160; else if (player1Pixel < 0) player1Pixel += 160;
            if (player1Enabled) changed = true;
        }
        add = (hMoveHitBlank ? HMM0 : HMM0 + 8); if (add !== 0) {
            missile0Pixel -= add; if (missile0Pixel >= 160) missile0Pixel -= 160; else if (missile0Pixel < 0) missile0Pixel += 160;
            if (missile0Enabled) changed = true;
        }
        add = (hMoveHitBlank ? HMM1 : HMM1 + 8); if (add !== 0) {
            missile1Pixel -= add; if (missile1Pixel >= 160) missile1Pixel -= 160; else if (missile1Pixel < 0) missile1Pixel += 160;
            if (missile1Enabled) changed = true;
        }
        add = (hMoveHitBlank ? HMBL : HMBL + 8); if (add !== 0) {
            ballPixel -= add; if (ballPixel >= 160) ballPixel -= 160; else if (ballPixel < 0) ballPixel += 160;
            if (ballEnabled) changed = true;
        }

        if (changed) changeClock = hMoveHitBlank ? HBLANK_DURATION + 8 : HBLANK_DURATION;
    };

    function getRESxPixel() {
        // Hit after complete HBLANK or last pixel of Extended HBLANK
        if (clock >= HBLANK_DURATION + (hMoveHitBlank ? 8 - 1 : 0)) {
            return clock - HBLANK_DURATION;
        } else {
            // Hit during HBLANK
            if (hMoveHitBlank) {
                if (clock >= HBLANK_DURATION) {
                    return 6;
                } else {
                    var d = (clock - hMoveHitClock - 4) >> 2;   // Shift right proportionally to distance from HMOVE, up to 8 pixels
                    if (d > 8) return 6;
                    else if (d > 1) return d - 2;
                    else return 158 + d;
                }
            } else
                return 158;
        }
    }

    function checkLateHMOVE() {
        if (hMoveLateHit) {
            hMoveLateHit = false;
            hMoveHitBlank = hMoveLateHitBlank;
            performHMOVE();
        } else
            hMoveHitBlank = false;
    }

    function updateExtendedHBLANK() {
        // Detect change in the extended HBLANK filling
        if (hMoveHitBlank !== (linePixels[HBLANK_DURATION] === hBlankColor)) {
            if (hMoveHitBlank) {
                // Fills the extended HBLANK portion of the current line
                linePixels[HBLANK_DURATION] = linePixels[HBLANK_DURATION + 1] = linePixels[HBLANK_DURATION + 2] = linePixels[HBLANK_DURATION + 3] =
                    linePixels[HBLANK_DURATION + 4] = linePixels[HBLANK_DURATION + 5] = linePixels[HBLANK_DURATION + 6] = linePixels[HBLANK_DURATION + 7] =
                        hBlankColor;    // This is faster than a fill
            } else
                changeClock = HBLANK_DURATION;
        }
        if (hMoveHitBlank) renderClock = HBLANK_DURATION + 8;
    }

    function endObjectsAltStatusMidLine() {
        if (player0Alt === 1)  { if (player0Enabled)  changeAtClock(); player0Alt = 0;  player0LineSpritePointer -= 20; }
        if (player1Alt === 1)  { if (player1Enabled)  changeAtClock(); player1Alt = 0;  player1LineSpritePointer -= 40; }
        if (missile0Alt === 1) { if (missile0Enabled) changeAtClock(); missile0Alt = 0; missile0LineSpritePointer -= 20; }
        if (missile1Alt === 1) { if (missile1Enabled) changeAtClock(); missile1Alt = 0; missile1LineSpritePointer -= 40; }
    }

    function endObjectsAltStatusEndOfLine() {
        if (player0Alt === 2)  { player0Alt = 0;  player0LineSpritePointer -= 20; }
        if (player1Alt === 2)  { player1Alt = 0;  player1LineSpritePointer -= 40; }
        if (missile0Alt === 2) { missile0Alt = 0; missile0LineSpritePointer -= 20; }
        if (missile1Alt === 2) { missile1Alt = 0; missile1LineSpritePointer -= 40; }
    }

    function vSyncSet(i) {
        if (debug) {
            debugPixel(VSYNC_COLOR);
            changeAtClock();
            vSyncOn = (i & 0x02) !== 0;
            vBlankColor = vSyncOn ? VSYNC_COLOR : DEBUG_VBLANK_COLOR;
        } else
            vSyncOn = (i & 0x02) !== 0;
    }

    var vBlankSet = function(blank) {
        var v = (blank & 0x02) !== 0;
        if (vBlankOn !== v) {
            changeVBlankAtClockPlus1();
            //changeAtClockPlus(1);
            vBlankOn = v;
        }

        if ((blank & 0x40) !== 0) {
            controlsButtonsLatched = true;			// Enable Joystick Button latches
        } else {
            controlsButtonsLatched = false;			// Disable latches and update registers with the current button state
            if (controlsJOY0ButtonPressed) INPT4 &= 0x7f; else INPT4 |= 0x80;
            if (controlsJOY1ButtonPressed) INPT5 &= 0x7f; else INPT5 |= 0x80;
        }

        if ((blank & 0x80) != 0) {					// Ground paddle capacitors
            paddleCapacitorsGrounded = true;
            paddle0CapacitorCharge = paddle1CapacitorCharge = 0;
            INPT0 &= 0x7f; INPT1 &= 0x7f; INPT2 &= 0x7f; INPT3 &= 0x7f;
        }
        else
            paddleCapacitorsGrounded = false;
    };

    var initLatchesAtPowerOn = function() {
        collisions = 0;
        INPT0 = INPT1 = INPT2 = INPT3 = 0;
        INPT4 = INPT5 = 0x80;
    };

    var debugPixel = function(color) {
        debugPixels[clock] = color;
    };

    var processDebugPixelsInLine = function() {
        jt.Util.arrayFillSegment(linePixels, 0, HBLANK_DURATION, hBlankColor);
        if (debugLevel >= 3 && videoSignal.monitor.currentLine() % 10 == 0) {
            for (var i = 0; i < LINE_WIDTH; i++) {
                if (debugPixels[i]) continue;
                if (i < HBLANK_DURATION) {
                    if (i % 6 == 0 || i == 66 || i == 63)
                        debugPixels[i] = DEBUG_MARKS_COLOR;
                } else {
                    if ((i - HBLANK_DURATION - 1) % 6 == 0)
                        debugPixels[i] = DEBUG_MARKS_COLOR;
                }
            }
        }
        if (debugLevel >= 2) {
            for (i = 0; i < LINE_WIDTH; i++) {
                if (debugPixels[i]) {
                    linePixels[i] = debugPixels[i];
                    debugPixels[i] = 0;
                }
            }
        }
    };

    var debugSetColors = function() {
        player0Color = DEBUG_P0_COLOR;
        player1Color = DEBUG_P1_COLOR;
        missile0Color = DEBUG_M0_COLOR;
        missile1Color = DEBUG_M1_COLOR;
        ballColor = DEBUG_BL_COLOR;
        playfieldLeftColor = playfieldRightColor = DEBUG_PF_COLOR;
        playfieldBackground = DEBUG_BK_COLOR;
        hBlankColor = debugLevel >= 1 ? DEBUG_HBLANK_COLOR : HBLANK_COLOR;
        vBlankColor = debugLevel >= 1 ? DEBUG_VBLANK_COLOR : VBLANK_COLOR;
    };

    var debugRestoreColors = function() {
        hBlankColor = HBLANK_COLOR;
        vBlankColor = VBLANK_COLOR;
        playfieldBackground = palette[0];
        jt.Util.arrayFill(linePixels, hBlankColor);
        changeAtClock();
    };

    var debugInfo = function(str) {
        if (debug) console.error("Line: " + videoSignal.monitor.currentLine() +", Pixel: " + clock + ". " + str);
    };

    // All possible entire line pixels for players, for all 8 bit patterns (sprites), including all variations (copies) and mirrors
    function generateObjectsLineSprites() {
        // Players
        var line = new Uint8Array(160);
        for (var mirror = 0; mirror <= 1; ++mirror) {
            for (var pattern = 0; pattern < 256; ++pattern) {
                var sprite = !mirror ? jt.Util.reverseInt8(pattern) : pattern;
                // 1 copy
                paintSprite(line, sprite, 4 + 1); addPlayerSprite(mirror, pattern, 0, 0, line);                   // 4 + 1 means player is delayed 4 + 1 pixels
                // 2 copies close
                paintSprite(line, sprite, 4 + 16 + 1); addPlayerSprite(mirror, pattern, 1, 0, line);
                // 3 copies close
                paintSprite(line, sprite, 4 + 32 + 1); addPlayerSprite(mirror, pattern, 3, 0, line);
                // 2 copies medium
                paintSprite(line, 0, 4 + 16 + 1); addPlayerSprite(mirror, pattern, 2, 0, line);                   // erase close copy
                // 3 copies medium
                paintSprite(line, sprite, 4 + 64 + 1); addPlayerSprite(mirror, pattern, 6, 0, line);
                // 2 copies wide
                paintSprite(line, 0, 4 + 32 + 1); addPlayerSprite(mirror, pattern, 4, 0, line);                   // erase medium copy
                // 1 copy double
                paintSprite(line, 0, 4 + 64 + 1); line[4 + 1] = 0;                                                // erase wide copy and first pixel
                paintSpriteDouble(line, sprite, 4 + 1 + 1); addPlayerSprite(mirror, pattern, 5, 0, line);         // 4 + 1 + 1 means Double and Quad are delayed 1 extra pixel
                // 1 copy quad
                paintSpriteQuad(line, sprite, 4 + 1 + 1); addPlayerSprite(mirror, pattern, 7, 0, line);
                // empty line
                paintSpriteQuad(line, 0, 4 + 1 + 1);
            }
        }

        // Missiles & Ball
        jt.Util.arrayFill(line, 0);
        for (var size = 0; size < 4; ++size) {
            sprite = (1 << (1 << size)) - 1;
            // 1 copy
            paintSprite(line, sprite, 4);                                                                         // 4 means missile/ball is delayed 4 pixels
            addMissileBallSprite(size, 0, 0, line);
            addMissileBallSprite(size, 5, 0, line);
            addMissileBallSprite(size, 7, 0, line);
            // 2 copies close
            paintSprite(line, sprite, 4 + 16); addMissileBallSprite(size, 1, 0, line);
            // 3 copies close
            paintSprite(line, sprite, 4 + 32); addMissileBallSprite(size, 3, 0, line);
            // 2 copies medium
            paintSprite(line, 0, 4 + 16); addMissileBallSprite(size, 2, 0, line);                                 // erase close copy
            // 3 copies medium
            paintSprite(line, sprite, 4 + 64); addMissileBallSprite(size, 6, 0, line);
            // 2 copies wide
            paintSprite(line, 0, 4 + 32); addMissileBallSprite(size, 4, 0, line);                                 // erase medium copy
            paintSprite(line, 0, 4);                                                                              // clean line: erase first and wide copy
            paintSprite(line, 0, 4 + 64);
        }

        function paintSprite(line, pat, pos) {
            for (var b = 0; b < 8; ++b) line[pos + b] = (pat >> b) & 1;
        }
        function paintSpriteDouble(line, pat, pos) {
            for (var b = 0; b < 8; ++b) line[pos + b*2] = line[pos + b*2 + 1] = (pat >> b) & 1;
        }
        function paintSpriteQuad(line, pat, pos) {
            for (var b = 0; b < 8; ++b) line[pos + b*4] = line[pos + b*4 + 1] = line[pos + b*4 + 2] = line[pos + b*4 + 3] = (pat >> b) & 1;
        }
        function addPlayerSprite(mirror, pattern, vari, alt, line) {
            var pos = (((mirror << 11) | (pattern << 3) | vari) << 6) + alt * 20;
            for (var i = 0; i < 20; ++i)
                for (var b = 0; b < 8; ++b)
                    if (line[i * 8 + b]) playerLineSprites[pos + i] |= 1 << b;

        }
        function addMissileBallSprite(size, vari, alt, line) {
            var pos = (((size << 3) | vari) << 6) + alt * 20;
            for (var i = 0; i < 20; ++i)
                for (var b = 0; b < 8; ++b)
                    if (line[i * 8 + b]) missileBallLineSprites[pos + i] |= 1 << b;

        }
    }

    function generateObjectsCopiesOffsets() {
        // Players
        jt.Util.arrayFill(playerCopiesOffsets, 0x80);
        // Normal Variations
        for (var p = 1; p < 13; ++p) {
            var v = p > 4 ? p | 0x40 : p;
            playerCopiesOffsets[0*160 + p] = v;
            playerCopiesOffsets[1*160 + p] = v;  playerCopiesOffsets[1*160 + p + 16] = v;
            playerCopiesOffsets[2*160 + p] = v;  playerCopiesOffsets[2*160 + p + 32] = v;
            playerCopiesOffsets[3*160 + p] = v;  playerCopiesOffsets[3*160 + p + 16] = v; playerCopiesOffsets[3*160 + p + 32] = v;
            playerCopiesOffsets[4*160 + p] = v;  playerCopiesOffsets[4*160 + p + 64] = v;
            playerCopiesOffsets[6*160 + p] = v;  playerCopiesOffsets[6*160 + p + 32] = v; playerCopiesOffsets[6*160 + p + 64] = v;
        }
        // Double Variation
        for (p = 1; p < 22; p++) { v = p > 5 ? p | 0x40 : p; playerCopiesOffsets[5 * 160 + p] = v; }
        // Wide Variation
        for (p = 1; p < 38; p++) { v = p > 5 ? p | 0x40 : p; playerCopiesOffsets[7 * 160 + p] = v; }

        // Missiles
        jt.Util.arrayFill(missileCopiesOffsets, 0x80);
        // All Size * Variations
        for (var s = 0; s <= 3; ++s) {
            var d = missileCopyLengthPerSize[s];
            for (p = 1; p < d; ++p) {
                v = p > 3 ? p | 0x40 : p;
                missileCopiesOffsets[s*8*160 + 0*160 + p] = v;
                missileCopiesOffsets[s*8*160 + 1*160 + p] = v;  missileCopiesOffsets[s*8 + 1*160 + p + 16] = v;
                missileCopiesOffsets[s*8*160 + 2*160 + p] = v;  missileCopiesOffsets[s*8 + 2*160 + p + 32] = v;
                missileCopiesOffsets[s*8*160 + 3*160 + p] = v;  missileCopiesOffsets[s*8 + 3*160 + p + 16] = v; missileCopiesOffsets[s*8*160 + 3*160 + p + 32] = v;
                missileCopiesOffsets[s*8*160 + 4*160 + p] = v;  missileCopiesOffsets[s*8 + 4*160 + p + 64] = v;
                missileCopiesOffsets[s*8*160 + 5*160 + p] = v;
                missileCopiesOffsets[s*8*160 + 6*160 + p] = v;  missileCopiesOffsets[s*8 + 6*160 + p + 32] = v; missileCopiesOffsets[s*8*160 + 6*160 + p + 64] = v;
                missileCopiesOffsets[s*8*160 + 7*160 + p] = v;
            }
        }
    }


    // Controls interface  -----------------------------------

    var controls = jt.ConsoleControls;

    this.controlStateChanged = function(control, state) {
        switch (control) {
            case controls.JOY0_BUTTON:
                if (state) {
                    controlsJOY0ButtonPressed = true;
                    INPT4 &= 0x7f;
                } else {
                    controlsJOY0ButtonPressed = false;
                    if (!controlsButtonsLatched)			// Does not lift the button if Latched Mode is on
                        INPT4 |= 0x80;
                }
                return;
            case controls.JOY1_BUTTON:
                if (state) {
                    controlsJOY1ButtonPressed = true;
                    INPT5 &= 0x7f;
                } else {
                    controlsJOY1ButtonPressed = false;
                    if (!controlsButtonsLatched)			// Does not lift the button if Latched Mode is on
                        INPT5 |= 0x80;
                }
                return;
        }
        // Toggles
        if (!state) return;
        switch (control) {
            case controls.DEBUG:
                self.debug(debugLevel + 1); return;
            case controls.NO_COLLISIONS:
                debugNoCollisions = !debugNoCollisions;
                videoSignal.showOSD(debugNoCollisions ? "Collisions OFF" : "Collisions ON", true);
                return;
            case controls.PAUSE:
                debugPause = !debugPause; debugPauseMoreFrames = 1;
                videoSignal.showOSD(debugPause ? "PAUSE" : "RESUME", true);
                return;
            case controls.FRAME:
                if (debugPause) debugPauseMoreFrames = 1;
                return;
            case controls.TRACE:
                cpu.trace = !cpu.trace; return;
        }
    };

    this.controlValueChanged = function(control, position) {
        switch (control) {
            case controls.PADDLE0_POSITION:
                paddle0Position = position; return;
            case controls.PADDLE1_POSITION:
                paddle1Position = position; return;
        }
    };

    this.controlsStateReport = function(report) {
        //  No TIA controls visible outside by now
    };


    // Savestate  ------------------------------------------------

    this.saveState = function() {
        return {
            lp:     btoa(jt.Util.uInt32ArrayToByteString(linePixels)),
            vs:     vSyncOn | 0,
            vb:     vBlankOn | 0,
            f:      jt.Util.booleanArrayToByteString(playfieldPatternL),
            fc:     playfieldLeftColor,
            fb:     playfieldBackground,
            fr:     playfieldReflected | 0,
            fs:     playfieldScoreMode | 0,
            ft:     playfieldPriority | 0,
            p0c:    player0Color,
            p1c:    player1Color,
            m0:     missile0Enabled | 0,
            m0c:    missile0Color,
            m1:     missile1Enabled | 0,
            m1c:    missile1Color,
            b:      ballEnabled | 0,
            bc:     ballColor,
            hb:     hMoveHitBlank | 0,
            hc:     hMoveHitClock,
            PF0:    PF0,
            PF1:    PF1,
            PF2:    PF2,
            AC0:    AUDC0,
            AC1:    AUDC1,
            AF0:    AUDF0,
            AF1:    AUDF1,
            AV0:    AUDV0,
            AV1:    AUDV1,
            HP0:    HMP0,
            HP1:    HMP1,
            HM0:    HMM0,
            HM1:    HMM1,
            HB:     HMBL
        };
    };

    this.loadState = function(state) {
        linePixels						 =  jt.Util.byteStringToUInt32Array(atob(state.lp));
        vSyncOn                     	 =  !!state.vs;
        vBlankOn                    	 =  !!state.vb;
        playfieldPatternL            	 =  jt.Util.byteStringToBooleanArray(state.f);      // TODO Migration
        playfieldLeftColor              	 =  state.fc;
        playfieldBackground         	 =  state.fb;
        playfieldReflected          	 =  !!state.fr;
        playfieldScoreMode          	 =  !!state.fs;
        playfieldPriority           	 =  !!state.ft;
        player0Color                	 =  state.p0c;
        player1Color                	 =  state.p1c;
        missile0Enabled             	 =  !!state.m0;
        missile0Color               	 =  state.m0c;
        missile1Enabled             	 =  !!state.m1;
        missile1Color               	 =  state.m1c;
        ballEnabled                 	 =  !!state.b;
        ballColor                   	 =  state.bc;
        hMoveHitBlank					 =  !!state.hb;
        hMoveHitClock					 =  state.hc;
        PF0								 =  state.PF0;
        PF1								 =  state.PF1;
        PF2								 =  state.PF2;
        AUDC0							 =  state.AC0; audioSignal.getChannel0().setControl(AUDC0 & 0x0f);		// Also update the Audio Generator
        AUDC1							 =  state.AC1; audioSignal.getChannel1().setControl(AUDC1 & 0x0f);
        AUDF0							 =  state.AF0; audioSignal.getChannel0().setDivider((AUDF0 & 0x1f) + 1);
        AUDF1							 =  state.AF1; audioSignal.getChannel1().setDivider((AUDF1 & 0x1f) + 1);
        AUDV0							 =  state.AV0; audioSignal.getChannel0().setVolume(AUDV0 & 0x0f);
        AUDV1							 =  state.AV1; audioSignal.getChannel1().setVolume(AUDV1 & 0x0f);
        HMP0							 =  state.HP0;
        HMP1							 =  state.HP1;
        HMM0							 =  state.HM0;
        HMM1							 =  state.HM1;
        HMBL							 =  state.HB;
        if (debug) debugSetColors();						// IF debug is on, ensure debug colors are used
    };


    // Constants  ------------------------------------------------

    var HBLANK_DURATION = 68;
    var LINE_WIDTH = 228;

    var VBLANK_COLOR = 0xff000000;		// CHECK: Full transparency needed for CRT emulation modes
    var HBLANK_COLOR = 0xfe000000;      // Alpha of 0xfe used to detect extended HBLANK (alpha is unnoticeable)
    var VSYNC_COLOR  = 0xffdddddd;

    var DEBUG_P0_COLOR     = 0xff0000ff;
    var DEBUG_P0_RES_COLOR = 0xff2222bb;
    var DEBUG_P0_GR_COLOR  = 0xff111177;
    var DEBUG_P1_COLOR     = 0xffff0000;
    var DEBUG_P1_RES_COLOR = 0xffbb2222;
    var DEBUG_P1_GR_COLOR  = 0xff771111;
    var DEBUG_M0_COLOR     = 0xff6666ff;
    var DEBUG_M1_COLOR     = 0xffff6666;
    var DEBUG_PF_COLOR     = 0xff448844;
    var DEBUG_PF_GR_COLOR  = 0xff33dd33;
    var DEBUG_BK_COLOR     = 0xff334433;
    var DEBUG_BL_COLOR     = 0xff00ffff;
    var DEBUG_MARKS_COLOR  = 0xff202020;
    var DEBUG_HBLANK_COLOR = 0xff444444;
    var DEBUG_VBLANK_COLOR = 0xff2a2a2a;
    var DEBUG_WSYNC_COLOR  = 0xff880088;
    var DEBUG_HMOVE_COLOR  = 0xffffffff;
    var DEBUG_ALT_COLOR    = 0xffaaaa00;

    var READ_ADDRESS_MASK  = 0x000f;
    var WRITE_ADDRESS_MASK = 0x003f;

    // Collision bit patterns:   P0P1, P0M0, P0M1, P0PF,   P0BL, P1M0, P1M1, P1PF,   P1BL, M0M1, M0PF, M0BL,   M1PF, M1BL, PFBL, none

    var P0C = ~0xf800;   //  1111 1000 0000 0000
    var P1C = ~0x8780;   //  1000 0111 1000 0000
    var M0C = ~0x4470;   //  0100 0100 0111 0000
    var M1C = ~0x224c;   //  0010 0010 0100 1100
    var PFC = ~0x112a;   //  0001 0001 0010 1010
    var BLC = ~0x0896;   //  0000 1000 1001 0110


    // Variables  ---------------------------------------------------

    var cpu = pCpu;
    var pia = pPia;
    var bus;

    var powerOn = false;
    var line = 0;

    var clock, changeClock, changeClockPrevLine, renderClock;
    var linePixels = new Uint32Array(LINE_WIDTH);

    var vSyncOn = false;
    var vBlankOn = false;
    var vBlankColor = VBLANK_COLOR;
    var hBlankColor = HBLANK_COLOR;

    var playfieldEnabled = false, playfieldPatternL = 0, playfieldPatternR = 0;
    var playfieldLeftColor = 0xff000000, playfieldRightColor = 0xff000000;
    var playfieldBackground = 0xff000000;
    var playfieldReflected = false;
    var playfieldScoreMode = false;
    var playfieldPriority = false;

    var ballEnabled = false, ballPixel = 0, ballLineSpritePointer = 0;
    var ballColor = 0xff000000;

    var player0Enabled = false, player0Pixel = 0, player0LineSpritePointer = 0;
    var player0Alt = 0, player0AltFrom = 0, player0AltLength = 0, player0AltCopyOffset = 0;
    var player0AltControl = new Uint32Array(2 * 256 * 8);
    var player0Color = 0xff000000;

    var player1Enabled = false, player1Pixel = 0, player1LineSpritePointer = 0;
    var player1Alt = 0, player1AltFrom = 0, player1AltLength = 0, player1AltCopyOffset = 0;
    var player1AltControl = new Uint32Array(2 * 256 * 8);
    var player1Color = 0xff000000;

    var missile0Enabled = false, missile0Pixel = 0, missile0LineSpritePointer = 0;
    var missile0Alt = 0, missile0AltFrom = 0, missile0AltLength = 0, missile0AltCopyOffset = 0;
    var missile0AltControl = new Uint32Array(4 * 8);
    var missile0Color = 0xff000000;

    var missile1Enabled = false, missile1Pixel = 0, missile1LineSpritePointer = 0;
    var missile1Alt = 0, missile1AltFrom = 0, missile1AltLength = 0, missile1AltCopyOffset = 0;
    var missile1AltControl = new Uint32Array(4 * 8);
    var missile1Color = 0xff000000;

    var hMoveHitBlank = false;
    var hMoveHitClock = 0;
    var hMoveLateHit = false;
    var hMoveLateHitBlank = false;

    var collisions = 0, collisionsPossible = 0;

    var debug = false;
    var debugLevel = 0;
    var debugNoCollisions = false;
    var debugPixels = new Uint32Array(LINE_WIDTH);
    var debugPause = false;
    var debugPauseMoreFrames = 0;

    var controlsButtonsLatched = false;
    var controlsJOY0ButtonPressed = false;
    var controlsJOY1ButtonPressed = false;

    var paddleCapacitorsGrounded = false;
    var paddle0Position = -1;			                                    // 380 = Left, 190 = Middle, 0 = Right. -1 = disconnected, won't charge POTs
    var paddle0CapacitorCharge = 0;
    var paddle1Position = -1;
    var paddle1CapacitorCharge = 0;

    var playerLineSprites = new Uint8Array(2 * 256 * 8 * 64);               // 2 Mirrors * 256 Patterns * 8 Variations * (1 base + 2 alts) * 20 8Bits line data specifying 1bit pixels + 4 bytes spare
    var missileBallLineSprites = new Uint8Array(4 * 8 * 64);                // 4 Sizes * 8 Variations * (1 base + 2 alts) * 20 8Bits line data specifying 1bit pixels + 4 bytes spare

    var playerCopyLengthPerShape = new Uint8Array([13, 13, 13, 13, 13, 22, 13, 38]);
    var missileCopyLengthPerSize = new Uint8Array([5, 6, 8, 12 ]);

    var playerCopiesOffsets = new Uint8Array(8 * 160);                      // 8 Variations * 160 1 byte data with copy pixel position
    var missileCopiesOffsets = new Uint8Array(4 * 8 * 160);                 // 4 Sizes * 8 Variations * 160 1 byte data with copy pixel position

    var objectsLineSpritePointerDeltaToSingleCopy = new Uint16Array([0 * 64, 1 * 64, 2 * 64, 3 * 64, 4 * 64, 0 * 64, 6 * 64, 0 * 64]);

    var missileCenterOffsetsPerPlayerSize = new Uint8Array([ 5, 5, 5, 5, 5, 10, 5, 18 ]);

    var videoSignal = new jt.TiaVideoSignal();
    var palette;

    var audioSignal = new jt.TiaAudioSignal();


    // Read registers -------------------------------------------

    var INPT0 =  0;     // Paddle0 Left pot port
    var INPT1 =  0;     // Paddle0 Right pot port
    var INPT2 =  0;     // Paddle1 Left pot port
    var INPT3 =  0;     // Paddle1 Right pot port
    var INPT4 =  0;     // input (Joy0 button)
    var INPT5 =  0;     // input (Joy1 button)


    // Write registers  ------------------------------------------

    var CTRLPF = 0;     // ..11.111  control playfield ball size & collisions
    var COLUPF = 0;     // 11111111  playfield and ball color
    var COLUBK = 0;     // 11111111  playfield background color
    var PF0 = 0;		// 1111....  playfield register byte 0
    var PF1 = 0;		// 11111111  playfield register byte 1
    var PF2 = 0;		// 11111111  playfield register byte 2
    var ENABL = 0;      // ......1.  graphics (enable) ball
    var ENABLd = 0;     // ......1.  graphics (enable) ball
    var VDELBL = 0;     // .......1  vertical delay ball

    var NUSIZ0 = 0;     // ..111111  number-size player-missile 0
    var COLUP0 = 0;     // 11111111  color-lum player 0 and missile 0
    var REFP0 = 0;      // ....1...  reflect player 0 (>> 3)
    var GRP0 = 0;       // 11111111  graphics player 0
    var GRP0d = 0;      // 11111111  graphics player 0 (delayed)
    var VDELP0 = 0;     // .......1  vertical delay player 0

    var NUSIZ1 = 0;     // ..111111  number-size player-missile 1
    var COLUP1 = 0;     // 11111111  color-lum player 1 and missile 1
    var REFP1 = 0;      // ....1...  reflect player 1 (>> 3)
    var GRP1 = 0;       // 11111111  graphics player 1
    var GRP1d = 0;      // 11111111  graphics player 1 (delayed)
    var VDELP1 = 0;     // .......1  vertical delay player 1

    var ENAM0 = 0;      // ......1.  graphics (enable) missile 0
    var RESMP0 = 0;     // ......1.  reset missile 0 to player 0

    var ENAM1 = 0;      // ......1.  graphics (enable) missile 1
    var RESMP1 = 0;     // ......1.  reset missile 1 to player 1

    var HMP0 = 0;		// 1111....  horizontal motion player 0
    var HMP1 = 0;		// 1111....  horizontal motion player 1
    var HMM0 = 0;		// 1111....  horizontal motion missile 0
    var HMM1 = 0;		// 1111....  horizontal motion missile 1
    var HMBL = 0;		// 1111....  horizontal motion ball

    var AUDC0 = 0;		// ....1111  audio control 0
    var AUDC1 = 0;		// ....1111  audio control 1
    var AUDF0 = 0;		// ...11111  audio frequency 0
    var AUDF1 = 0;		// ...11111  audio frequency 1
    var AUDV0 = 0;		// ....1111  audio volume 0
    var AUDV1 = 0;		// ....1111  audio volume 1

    init();

    self.eval = function(code) {
        return eval(code);
    }

};
