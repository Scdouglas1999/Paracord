import { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import {
  Search,
  Smile,
  Leaf,
  Pizza,
  Trophy,
  Plane,
  Lightbulb,
  Hash,
  Flag,
  type LucideIcon,
} from 'lucide-react';
import type { GuildEmoji } from '../../types';
import { emojiApi } from '../../api/emojis';
import { buildGuildEmojiImageUrl, formatCustomEmojiToken } from '../../lib/customEmoji';
import { cn } from '../../lib/utils';
import { EmptyState } from './Feedback';
import { Skeleton } from './Skeleton';

// ---------------------------------------------------------------------------
// Emoji data
// ---------------------------------------------------------------------------

interface EmojiCategory {
  name: string;
  emojis: string[];
}

const EMOJI_CATEGORIES: EmojiCategory[] = [
  {
    name: 'Smileys & People',
    emojis: [
      '\u{1F600}','\u{1F603}','\u{1F604}','\u{1F601}','\u{1F606}','\u{1F605}','\u{1F923}','\u{1F602}',
      '\u{1F642}','\u{1F643}','\u{1F609}','\u{1F60A}','\u{1F607}','\u{1F970}','\u{1F60D}','\u{1F929}',
      '\u{1F618}','\u{1F617}','\u{1F61A}','\u{1F619}','\u{1F972}','\u{1F60B}','\u{1F61B}','\u{1F61C}',
      '\u{1F92A}','\u{1F61D}','\u{1F911}','\u{1F917}','\u{1F92D}','\u{1F92B}','\u{1F914}','\u{1FAE1}',
      '\u{1F910}','\u{1F928}','\u{1F610}','\u{1F611}','\u{1F636}','\u{1FAE5}','\u{1F60F}','\u{1F612}',
      '\u{1F644}','\u{1F62C}','\u{1F925}','\u{1F60C}','\u{1F614}','\u{1F62A}','\u{1F924}','\u{1F634}',
      '\u{1F637}','\u{1F912}','\u{1F915}','\u{1F922}','\u{1F92E}','\u{1F975}','\u{1F976}','\u{1F974}',
      '\u{1F635}','\u{1F92F}','\u{1F920}','\u{1F973}','\u{1F978}','\u{1F60E}','\u{1F913}','\u{1F9D0}',
      '\u{1F615}','\u{1FAE4}','\u{1F61F}','\u{1F641}','\u{1F62E}','\u{1F62F}','\u{1F632}','\u{1F633}',
      '\u{1F97A}','\u{1F979}','\u{1F626}','\u{1F627}','\u{1F628}','\u{1F630}','\u{1F625}','\u{1F622}',
      '\u{1F62D}','\u{1F631}','\u{1F616}','\u{1F623}','\u{1F61E}','\u{1F613}','\u{1F629}','\u{1F62B}',
      '\u{1F971}','\u{1F624}','\u{1F621}','\u{1F620}','\u{1F92C}','\u{1F608}','\u{1F47F}','\u{1F480}',
      '\u{2620}\u{FE0F}','\u{1F4A9}','\u{1F921}','\u{1F479}','\u{1F47A}','\u{1F47B}','\u{1F47D}','\u{1F47E}',
      '\u{1F916}','\u{1F63A}','\u{1F638}','\u{1F639}','\u{1F63B}','\u{1F63C}','\u{1F63D}','\u{1F640}',
      '\u{1F63F}','\u{1F63E}','\u{1F44B}','\u{1F91A}','\u{1F590}\u{FE0F}','\u{270B}','\u{1F596}',
      '\u{1FAF1}','\u{1FAF2}','\u{1FAF3}','\u{1FAF4}','\u{1F44C}','\u{1F90C}','\u{1F90F}',
      '\u{270C}\u{FE0F}','\u{1F91E}','\u{1FAF0}','\u{1F91F}','\u{1F918}','\u{1F919}','\u{1F448}',
      '\u{1F449}','\u{1F446}','\u{1F595}','\u{1F447}','\u{261D}\u{FE0F}','\u{1FAF5}','\u{1F44D}',
      '\u{1F44E}','\u{270A}','\u{1F44A}','\u{1F91B}','\u{1F91C}','\u{1F44F}','\u{1F64C}','\u{1FAF6}',
      '\u{1F450}','\u{1F932}','\u{1F91D}','\u{1F64F}','\u{1F4AA}',
    ],
  },
  {
    name: 'Animals & Nature',
    emojis: [
      '\u{1F436}','\u{1F431}','\u{1F42D}','\u{1F439}','\u{1F430}','\u{1F98A}','\u{1F43B}','\u{1F43C}',
      '\u{1F43B}\u{200D}\u{2744}\u{FE0F}','\u{1F428}','\u{1F42F}','\u{1F981}','\u{1F42E}','\u{1F437}',
      '\u{1F438}','\u{1F435}','\u{1F648}','\u{1F649}','\u{1F64A}','\u{1F412}','\u{1F414}','\u{1F427}',
      '\u{1F426}','\u{1F424}','\u{1F423}','\u{1F425}','\u{1F986}','\u{1F985}','\u{1F989}','\u{1F987}',
      '\u{1F43A}','\u{1F417}','\u{1F434}','\u{1F984}','\u{1F41D}','\u{1FAB1}','\u{1F41B}','\u{1F98B}',
      '\u{1F40C}','\u{1F41E}','\u{1F41C}','\u{1FAB0}','\u{1FAB2}','\u{1FAB3}','\u{1F99F}','\u{1F997}',
      '\u{1F577}\u{FE0F}','\u{1F338}','\u{1F33A}','\u{1F33B}','\u{1F339}','\u{1F337}','\u{1F33C}',
      '\u{1F490}','\u{1F33E}','\u{1F340}','\u{1F341}','\u{1F342}','\u{1F343}','\u{1F33F}',
      '\u{2618}\u{FE0F}','\u{1FAB4}','\u{1F331}','\u{1F332}','\u{1F333}','\u{1F334}','\u{1FAB9}',
      '\u{1FABA}','\u{1F344}','\u{1F335}','\u{1F41A}','\u{1FAB8}','\u{1FAA8}','\u{1F33E}','\u{1F4AE}',
      '\u{1F3F5}\u{FE0F}','\u{1F308}','\u{1F30A}',
    ],
  },
  {
    name: 'Food & Drink',
    emojis: [
      '\u{1F34F}','\u{1F34E}','\u{1F350}','\u{1F34A}','\u{1F34B}','\u{1F34C}','\u{1F349}','\u{1F347}',
      '\u{1F353}','\u{1FAD0}','\u{1F348}','\u{1F352}','\u{1F351}','\u{1F96D}','\u{1F34D}','\u{1F965}',
      '\u{1F95D}','\u{1F345}','\u{1F346}','\u{1F951}','\u{1F966}','\u{1F96C}','\u{1F952}',
      '\u{1F336}\u{FE0F}','\u{1FAD1}','\u{1F33D}','\u{1F955}','\u{1FAD2}','\u{1F9C4}','\u{1F9C5}',
      '\u{1F954}','\u{1F360}','\u{1FAD8}','\u{1F950}','\u{1F35E}','\u{1F956}','\u{1F968}','\u{1F9C0}',
      '\u{1F95A}','\u{1F373}','\u{1F9C8}','\u{1F95E}','\u{1F9C7}','\u{1F953}','\u{1F969}','\u{1F357}',
      '\u{1F356}','\u{1F9B4}','\u{1F32D}','\u{1F354}','\u{1F35F}','\u{1F355}','\u{1FAD3}','\u{1F96A}',
      '\u{1F32E}','\u{1F32F}','\u{1FAD4}','\u{1F959}','\u{1F9C6}','\u{1F957}','\u{1F958}','\u{1FAD5}',
      '\u{1F35D}','\u{1F35C}','\u{1F372}','\u{1F35B}','\u{1F363}','\u{1F371}','\u{1F95F}','\u{1F9AA}',
      '\u{1F364}','\u{1F359}','\u{1F35A}','\u{1F358}','\u{1F365}','\u{1F960}','\u{1F96E}','\u{1F367}',
      '\u{1F368}','\u{1F366}','\u{1F967}','\u{1F9C1}','\u{1F370}','\u{1F382}','\u{1F36E}','\u{1F36D}',
      '\u{1F36C}','\u{1F36B}','\u{1F37F}','\u{1F369}','\u{1F36A}','\u{1F330}','\u{1F95C}','\u{1F36F}',
      '\u{1F95B}','\u{1FAD7}','\u{2615}','\u{1F375}','\u{1F9C3}','\u{1F964}','\u{1F9CB}','\u{1F376}',
      '\u{1F37A}','\u{1F37B}','\u{1F942}','\u{1F377}','\u{1FAD9}','\u{1F943}','\u{1F378}','\u{1F379}',
      '\u{1F9C9}','\u{1F37E}','\u{1FAD6}','\u{1F37D}\u{FE0F}','\u{1F944}','\u{1F374}','\u{1F962}',
    ],
  },
  {
    name: 'Activities',
    emojis: [
      '\u{26BD}','\u{1F3C0}','\u{1F3C8}','\u{26BE}','\u{1F94E}','\u{1F3BE}','\u{1F3D0}','\u{1F3C9}',
      '\u{1F94F}','\u{1F3B1}','\u{1FA80}','\u{1F3D3}','\u{1F3F8}','\u{1F3D2}','\u{1F3D1}','\u{1F94D}',
      '\u{1F3CF}','\u{1FA83}','\u{1F945}','\u{26F3}','\u{1FA81}','\u{1F3F9}','\u{1F3A3}','\u{1F93F}',
      '\u{1F94A}','\u{1F94B}','\u{1F3BD}','\u{1F6F9}','\u{1F6FC}','\u{1F6F7}','\u{26F8}\u{FE0F}',
      '\u{1F94C}','\u{1F3BF}','\u{26F7}\u{FE0F}','\u{1F3C2}','\u{1FA82}','\u{1F3CB}\u{FE0F}',
      '\u{1F938}','\u{1F93A}','\u{26F9}\u{FE0F}','\u{1F93E}','\u{1F3CC}\u{FE0F}','\u{1F3C7}',
      '\u{1F9D8}','\u{1F3C4}','\u{1F3CA}','\u{1F93D}','\u{1F6A3}','\u{1F9D7}','\u{1F6B4}','\u{1F6B5}',
      '\u{1F3AA}','\u{1F3AD}','\u{1F3A8}','\u{1F3AC}','\u{1F3A4}','\u{1F3A7}','\u{1F3BC}','\u{1F3B9}',
      '\u{1F941}','\u{1FA98}','\u{1F3B7}','\u{1F3BA}','\u{1FA97}','\u{1F3B8}','\u{1FA95}','\u{1F3BB}',
      '\u{1F3B2}','\u{265F}\u{FE0F}','\u{1F3AF}','\u{1F3B3}','\u{1F3AE}','\u{1F579}\u{FE0F}',
      '\u{1F9E9}','\u{1F0CF}','\u{1F004}','\u{1F3B4}','\u{1F3B0}','\u{1F9F8}',
    ],
  },
  {
    name: 'Travel & Places',
    emojis: [
      '\u{1F697}','\u{1F695}','\u{1F699}','\u{1F3CE}\u{FE0F}','\u{1F68C}','\u{1F68E}','\u{1F690}',
      '\u{1F691}','\u{1F692}','\u{1F693}','\u{1F694}','\u{1F696}','\u{1F698}','\u{1F68D}','\u{1F6B2}',
      '\u{1F6F4}','\u{1F6F5}','\u{1F3CD}\u{FE0F}','\u{1F694}','\u{1F6A8}','\u{1F683}','\u{1F68B}',
      '\u{1F69E}','\u{1F69D}','\u{1F684}','\u{1F685}','\u{1F688}','\u{1F682}','\u{1F686}','\u{1F687}',
      '\u{1F68A}','\u{1F689}','\u{2708}\u{FE0F}','\u{1F6EB}','\u{1F6EC}','\u{1F4BA}','\u{1F680}',
      '\u{1F6F8}','\u{1F681}','\u{1F6F6}','\u{26F5}','\u{1F6A4}','\u{1F6E5}\u{FE0F}',
      '\u{1F6F3}\u{FE0F}','\u{26F4}\u{FE0F}','\u{1F6A2}','\u{1F3E0}','\u{1F3E1}','\u{1F3D8}\u{FE0F}',
      '\u{1F3E2}','\u{1F3E3}','\u{1F3E4}','\u{1F3E5}','\u{1F3E6}','\u{1F3E8}','\u{1F3EA}','\u{1F3EB}',
      '\u{1F3EC}','\u{1F3ED}','\u{1F3D7}\u{FE0F}','\u{1F3DB}\u{FE0F}','\u{26EA}','\u{1F54C}',
      '\u{1F6D5}','\u{1F54D}','\u{26E9}\u{FE0F}','\u{1F54B}','\u{26F2}','\u{26FA}','\u{1F301}',
      '\u{1F303}','\u{1F3D9}\u{FE0F}','\u{1F304}','\u{1F305}','\u{1F306}','\u{1F307}','\u{1F309}',
      '\u{1F5FC}','\u{1F5FD}','\u{1F5FB}','\u{1F3D4}\u{FE0F}','\u{1F30B}','\u{1F3D5}\u{FE0F}',
      '\u{1F3D6}\u{FE0F}','\u{1F3DC}\u{FE0F}','\u{1F3DD}\u{FE0F}','\u{1F3DE}\u{FE0F}','\u{1F3A0}',
      '\u{1F3A1}','\u{1F3A2}','\u{1F3AA}','\u{1F488}',
    ],
  },
  {
    name: 'Objects',
    emojis: [
      '\u{231A}','\u{1F4F1}','\u{1F4F2}','\u{1F4BB}','\u{2328}\u{FE0F}','\u{1F5A5}\u{FE0F}',
      '\u{1F5A8}\u{FE0F}','\u{1F5B1}\u{FE0F}','\u{1F5B2}\u{FE0F}','\u{1F4BE}','\u{1F4BF}','\u{1F4C0}',
      '\u{1F4F9}','\u{1F4F7}','\u{1F4F8}','\u{1F4FC}','\u{1F50D}','\u{1F50E}','\u{1F56F}\u{FE0F}',
      '\u{1F4A1}','\u{1F526}','\u{1F3EE}','\u{1FA94}','\u{1F4D4}','\u{1F4D5}','\u{1F4D6}','\u{1F4D7}',
      '\u{1F4D8}','\u{1F4D9}','\u{1F4DA}','\u{1F4D3}','\u{1F4D2}','\u{1F4C3}','\u{1F4DC}','\u{1F4C4}',
      '\u{1F4F0}','\u{1F5DE}\u{FE0F}','\u{1F4D1}','\u{1F516}','\u{1F3F7}\u{FE0F}','\u{1F4B0}',
      '\u{1FA99}','\u{1F4B4}','\u{1F4B5}','\u{1F4B6}','\u{1F4B7}','\u{1F4B8}','\u{1F4B3}','\u{1F9FE}',
      '\u{1F4B9}','\u{2709}\u{FE0F}','\u{1F4E7}','\u{1F4E8}','\u{1F4E9}','\u{1F4E4}','\u{1F4E5}',
      '\u{1F4E6}','\u{1F4EB}','\u{1F4EA}','\u{1F4EC}','\u{1F4ED}','\u{1F4EE}','\u{1F5F3}\u{FE0F}',
      '\u{270F}\u{FE0F}','\u{2712}\u{FE0F}','\u{1F58B}\u{FE0F}','\u{1F58A}\u{FE0F}',
      '\u{1F58C}\u{FE0F}','\u{1F58D}\u{FE0F}','\u{1F4DD}','\u{1F4C1}','\u{1F4C2}',
      '\u{1F5C2}\u{FE0F}','\u{1F4C5}','\u{1F4C6}','\u{1F4C7}','\u{1F4C8}','\u{1F4C9}','\u{1F4CA}',
      '\u{1F4CB}','\u{1F4CC}','\u{1F4CD}','\u{1F4CE}','\u{1F587}\u{FE0F}','\u{1F4CF}','\u{1F4D0}',
      '\u{2702}\u{FE0F}','\u{1F5C3}\u{FE0F}','\u{1F5C4}\u{FE0F}','\u{1F5D1}\u{FE0F}','\u{1F512}',
      '\u{1F513}','\u{1F50F}','\u{1F510}','\u{1F511}','\u{1F5DD}\u{FE0F}','\u{1F528}','\u{1FA93}',
      '\u{26CF}\u{FE0F}','\u{2692}\u{FE0F}','\u{1F6E0}\u{FE0F}','\u{1F5E1}\u{FE0F}',
      '\u{2694}\u{FE0F}','\u{1F52B}','\u{1FA83}','\u{1F6E1}\u{FE0F}','\u{1FA9A}','\u{1F527}',
      '\u{1FA9B}','\u{1F529}','\u{2699}\u{FE0F}','\u{1F5DC}\u{FE0F}','\u{2696}\u{FE0F}','\u{1F9AF}',
      '\u{1F517}','\u{26D3}\u{FE0F}','\u{1FA9D}','\u{1F9F0}','\u{1F9F2}','\u{1FA9C}',
    ],
  },
  {
    name: 'Symbols',
    emojis: [
      '\u{2764}\u{FE0F}','\u{1F9E1}','\u{1F49B}','\u{1F49A}','\u{1F499}','\u{1F49C}','\u{1F5A4}',
      '\u{1F90D}','\u{1F90E}','\u{1F494}','\u{2764}\u{FE0F}\u{200D}\u{1F525}',
      '\u{2764}\u{FE0F}\u{200D}\u{1FA79}','\u{2763}\u{FE0F}','\u{1F495}','\u{1F49E}','\u{1F493}',
      '\u{1F497}','\u{1F496}','\u{1F498}','\u{1F49D}','\u{1F49F}','\u{262E}\u{FE0F}',
      '\u{271D}\u{FE0F}','\u{262A}\u{FE0F}','\u{1F549}\u{FE0F}','\u{2638}\u{FE0F}',
      '\u{2721}\u{FE0F}','\u{1F52F}','\u{1F54E}','\u{262F}\u{FE0F}','\u{2626}\u{FE0F}','\u{1F6D0}',
      '\u{26CE}','\u{2648}','\u{2649}','\u{264A}','\u{264B}','\u{264C}','\u{264D}','\u{264E}',
      '\u{264F}','\u{2650}','\u{2651}','\u{2652}','\u{2653}','\u{1F194}','\u{269B}\u{FE0F}',
      '\u{1F251}','\u{2622}\u{FE0F}','\u{2623}\u{FE0F}','\u{1F4F4}','\u{1F4F3}','\u{1F236}',
      '\u{1F21A}','\u{1F238}','\u{1F23A}','\u{1F237}\u{FE0F}','\u{2734}\u{FE0F}','\u{1F19A}',
      '\u{1F4AE}','\u{1F250}','\u{3299}\u{FE0F}','\u{3297}\u{FE0F}','\u{1F234}','\u{1F235}',
      '\u{1F239}','\u{1F232}','\u{1F170}\u{FE0F}','\u{1F171}\u{FE0F}','\u{1F18E}','\u{1F191}',
      '\u{1F17E}\u{FE0F}','\u{1F198}','\u{274C}','\u{2B55}','\u{1F6D1}','\u{26D4}','\u{1F4DB}',
      '\u{1F6AB}','\u{1F4AF}','\u{1F4A2}','\u{2668}\u{FE0F}','\u{1F6B7}','\u{1F6AF}','\u{1F6B3}',
      '\u{1F6B1}','\u{1F51E}','\u{1F4F5}','\u{1F6AD}','\u{2757}','\u{2755}','\u{2753}','\u{2754}',
      '\u{203C}\u{FE0F}','\u{2049}\u{FE0F}','\u{1F505}','\u{1F506}','\u{303D}\u{FE0F}',
      '\u{26A0}\u{FE0F}','\u{1F6B8}','\u{1F531}','\u{269C}\u{FE0F}','\u{1F530}','\u{267B}\u{FE0F}',
      '\u{2705}','\u{1F22F}','\u{1F4B9}','\u{2747}\u{FE0F}','\u{2733}\u{FE0F}','\u{274E}','\u{1F310}',
      '\u{1F4A0}','\u{24C2}\u{FE0F}','\u{1F300}','\u{1F4A4}','\u{1F3E7}','\u{1F6BE}','\u{267F}',
      '\u{1F17F}\u{FE0F}','\u{1F6D7}','\u{1F233}','\u{1F202}\u{FE0F}','\u{1F6C2}','\u{1F6C3}',
      '\u{1F6C4}','\u{1F6C5}','\u{1F6B9}','\u{1F6BA}','\u{1F6BC}','\u{26A7}\u{FE0F}','\u{1F6BB}',
      '\u{1F6AE}','\u{1F3A6}','\u{1F4F6}','\u{1F201}','\u{1F523}','\u{2139}\u{FE0F}','\u{1F524}',
      '\u{1F521}','\u{1F520}','\u{1F196}','\u{1F197}','\u{1F199}','\u{1F192}','\u{1F195}','\u{1F193}',
      '0\u{FE0F}\u{20E3}','1\u{FE0F}\u{20E3}','2\u{FE0F}\u{20E3}','3\u{FE0F}\u{20E3}',
      '4\u{FE0F}\u{20E3}','5\u{FE0F}\u{20E3}','6\u{FE0F}\u{20E3}','7\u{FE0F}\u{20E3}',
      '8\u{FE0F}\u{20E3}','9\u{FE0F}\u{20E3}','\u{1F51F}','\u{1F522}','#\u{FE0F}\u{20E3}',
      '*\u{FE0F}\u{20E3}','\u{23CF}\u{FE0F}','\u{25B6}\u{FE0F}','\u{23F8}\u{FE0F}',
      '\u{23EF}\u{FE0F}','\u{23F9}\u{FE0F}','\u{23FA}\u{FE0F}','\u{23ED}\u{FE0F}',
      '\u{23EE}\u{FE0F}','\u{23E9}','\u{23EA}','\u{23EB}','\u{23EC}','\u{25C0}\u{FE0F}','\u{1F53C}',
      '\u{1F53D}','\u{27A1}\u{FE0F}','\u{2B05}\u{FE0F}','\u{2B06}\u{FE0F}','\u{2B07}\u{FE0F}',
      '\u{2197}\u{FE0F}','\u{2198}\u{FE0F}','\u{2199}\u{FE0F}','\u{2196}\u{FE0F}',
      '\u{2195}\u{FE0F}','\u{2194}\u{FE0F}','\u{21A9}\u{FE0F}','\u{21AA}\u{FE0F}',
      '\u{2934}\u{FE0F}','\u{2935}\u{FE0F}','\u{1F500}','\u{1F501}','\u{1F502}','\u{1F504}',
      '\u{1F503}','\u{1F3B5}','\u{1F3B6}','\u{2795}','\u{2796}','\u{2797}','\u{2716}\u{FE0F}',
      '\u{1F7F0}','\u{267E}\u{FE0F}','\u{1F4B2}','\u{1F4B1}','\u{2122}\u{FE0F}','\u{00A9}\u{FE0F}',
      '\u{00AE}\u{FE0F}','\u{3030}\u{FE0F}','\u{27B0}','\u{27BF}','\u{1F51A}','\u{1F519}','\u{1F51B}',
      '\u{1F51D}','\u{1F51C}','\u{2714}\u{FE0F}','\u{2611}\u{FE0F}','\u{1F518}','\u{1F534}','\u{1F7E0}',
      '\u{1F7E1}','\u{1F7E2}','\u{1F535}','\u{1F7E3}','\u{26AB}','\u{26AA}','\u{1F7E4}','\u{1F53A}',
      '\u{1F53B}','\u{1F538}','\u{1F539}','\u{1F536}','\u{1F537}','\u{1F533}','\u{1F532}',
      '\u{25AA}\u{FE0F}','\u{25AB}\u{FE0F}','\u{25FE}','\u{25FD}','\u{25FC}\u{FE0F}',
      '\u{25FB}\u{FE0F}','\u{1F7E5}','\u{1F7E7}','\u{1F7E8}','\u{1F7E9}','\u{1F7E6}','\u{1F7EA}',
      '\u{2B1B}','\u{2B1C}','\u{1F7EB}',
    ],
  },
  {
    name: 'Flags',
    emojis: [
      '\u{1F3C1}','\u{1F6A9}','\u{1F38C}','\u{1F3F4}','\u{1F3F3}\u{FE0F}',
      '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}','\u{1F3F3}\u{FE0F}\u{200D}\u{26A7}\u{FE0F}',
      '\u{1F3F4}\u{200D}\u{2620}\u{FE0F}',
      '\u{1F1FA}\u{1F1F8}','\u{1F1EC}\u{1F1E7}','\u{1F1E8}\u{1F1E6}','\u{1F1E6}\u{1F1FA}',
      '\u{1F1E9}\u{1F1EA}','\u{1F1EB}\u{1F1F7}','\u{1F1EF}\u{1F1F5}','\u{1F1F0}\u{1F1F7}',
      '\u{1F1E7}\u{1F1F7}','\u{1F1EE}\u{1F1F3}','\u{1F1EE}\u{1F1F9}','\u{1F1EA}\u{1F1F8}',
      '\u{1F1F2}\u{1F1FD}','\u{1F1F7}\u{1F1FA}','\u{1F1E8}\u{1F1F3}','\u{1F1F3}\u{1F1F1}',
      '\u{1F1F8}\u{1F1EA}','\u{1F1F3}\u{1F1F4}','\u{1F1E9}\u{1F1F0}','\u{1F1EB}\u{1F1EE}',
      '\u{1F1F5}\u{1F1F1}','\u{1F1F9}\u{1F1F7}','\u{1F1FF}\u{1F1E6}','\u{1F1E6}\u{1F1F7}',
      '\u{1F1E8}\u{1F1F4}','\u{1F1E8}\u{1F1ED}','\u{1F1E6}\u{1F1F9}','\u{1F1E7}\u{1F1EA}',
      '\u{1F1F5}\u{1F1F9}','\u{1F1EC}\u{1F1F7}','\u{1F1EE}\u{1F1EA}','\u{1F1F3}\u{1F1FF}',
      '\u{1F1F8}\u{1F1EC}','\u{1F1F9}\u{1F1ED}','\u{1F1FB}\u{1F1F3}','\u{1F1F5}\u{1F1ED}',
      '\u{1F1EE}\u{1F1E9}','\u{1F1F2}\u{1F1FE}','\u{1F1EA}\u{1F1EC}','\u{1F1F3}\u{1F1EC}',
      '\u{1F1F0}\u{1F1EA}','\u{1F1FA}\u{1F1E6}','\u{1F1F7}\u{1F1F4}','\u{1F1ED}\u{1F1FA}',
      '\u{1F1E8}\u{1F1FF}','\u{1F1F8}\u{1F1F0}','\u{1F1ED}\u{1F1F7}','\u{1F1F7}\u{1F1F8}',
      '\u{1F1E7}\u{1F1EC}','\u{1F1F1}\u{1F1F9}','\u{1F1F1}\u{1F1FB}','\u{1F1EA}\u{1F1EA}',
    ],
  },
];

// Category navigation uses consistent lucide line icons — never emoji-as-chrome
// (kill-list #3). Keyed by category name so the tab row stays in lockstep.
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  'Smileys & People': Smile,
  'Animals & Nature': Leaf,
  'Food & Drink': Pizza,
  Activities: Trophy,
  'Travel & Places': Plane,
  Objects: Lightbulb,
  Symbols: Hash,
  Flags: Flag,
};

// ---------------------------------------------------------------------------
// localStorage helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'paracord:quick-react-emojis';
const DEFAULT_FAVORITES = ['\u{1F44D}', '\u{2764}\u{FE0F}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F621}', '\u{1F389}', '\u{1F525}'];

function loadFavorites(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length === 8) return parsed;
    }
  } catch {
    // ignore parse errors
  }
  return [...DEFAULT_FAVORITES];
}

function saveFavorites(favorites: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
}

// ---------------------------------------------------------------------------
// EmojiPicker
// ---------------------------------------------------------------------------

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  position?: { x: number; y: number };
  guildId?: string;
}

export function EmojiPicker({ onSelect, onClose, position, guildId }: EmojiPickerProps) {
  const [favorites, setFavorites] = useState<string[]>(loadFavorites);
  const [customizeMode, setCustomizeMode] = useState(false);
  const [customizeSlot, setCustomizeSlot] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'unicode' | 'server'>('unicode');
  const [activeCategory, setActiveCategory] = useState(0);
  const [serverEmojis, setServerEmojis] = useState<GuildEmoji[]>([]);
  const [loadingServerEmojis, setLoadingServerEmojis] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const categoryRefs = useRef<(HTMLDivElement | null)[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);

  const fetchServerEmojis = useCallback(() => {
    if (!guildId) {
      setServerEmojis([]);
      return;
    }
    setLoadingServerEmojis(true);
    emojiApi
      .listGuild(guildId)
      .then(({ data }) => {
        setServerEmojis(data);
      })
      .catch(() => {
        setServerEmojis([]);
      })
      .finally(() => {
        setLoadingServerEmojis(false);
      });
  }, [guildId]);

  useEffect(() => {
    fetchServerEmojis();
  }, [fetchServerEmojis]);

  // Inline mode has no backdrop — dismiss on outside click / Escape. Popup mode
  // already has a full-screen click catcher; Escape still needs a listener.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);

    if (position) {
      return () => document.removeEventListener('keydown', onKeyDown);
    }

    const onPointerDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose, position]);

  // Listen for real-time emoji changes from the gateway.
  // Match StickerPicker: refresh when guild_id matches OR is omitted (broadcast).
  useEffect(() => {
    if (!guildId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ guild_id?: string }>).detail;
      if (detail?.guild_id && detail.guild_id !== guildId) return;
      fetchServerEmojis();
    };
    window.addEventListener('paracord:emojis-changed', handler);
    return () => window.removeEventListener('paracord:emojis-changed', handler);
  }, [guildId, fetchServerEmojis]);

  // Filtered categories when searching
  const filteredCategories = useMemo(() => {
    if (!search.trim()) return EMOJI_CATEGORIES;

    const query = search.trim().toLowerCase();
    // Simple substring match on category name; for a real app you'd match on
    // emoji names/keywords, but since we have no name metadata we filter by
    // category name only. This still makes the search bar useful for narrowing
    // by category, and selecting the full grid otherwise.
    const results: EmojiCategory[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      if (cat.name.toLowerCase().includes(query)) {
        results.push(cat);
      } else {
        // Still include individual emojis (pass them all; the emoji characters
        // themselves can be searched since some match Unicode names partially).
        // For a lightweight approach we just show all emojis as one flat list
        // when the search doesn't match a category.
      }
    }
    if (results.length > 0) return results;

    // Fallback: show all as a single "Search Results" category
    const flat: string[] = [];
    for (const cat of EMOJI_CATEGORIES) {
      flat.push(...cat.emojis);
    }
    return [{ name: 'Search Results', emojis: flat }];
  }, [search]);

  const filteredServerEmojis = useMemo(() => {
    if (!search.trim()) {
      return serverEmojis;
    }
    const query = search.trim().toLowerCase();
    return serverEmojis.filter((emoji) => emoji.name.toLowerCase().includes(query));
  }, [search, serverEmojis]);

  // Track scroll to highlight active category tab
  const handleGridScroll = useCallback(() => {
    if (!gridRef.current || search.trim() || activeTab !== 'unicode') return;
    const scrollTop = gridRef.current.scrollTop;
    let closest = 0;
    for (let i = 0; i < categoryRefs.current.length; i++) {
      const el = categoryRefs.current[i];
      if (el && el.offsetTop <= scrollTop + 40) {
        closest = i;
      }
    }
    setActiveCategory(closest);
  }, [search, activeTab]);

  // Scroll to category on tab click
  const scrollToCategory = useCallback((index: number) => {
    const el = categoryRefs.current[index];
    if (el && gridRef.current) {
      gridRef.current.scrollTo({ top: el.offsetTop, behavior: 'smooth' });
    }
    setActiveCategory(index);
  }, []);

  // Handle emoji click
  const handleEmojiClick = useCallback(
    (emoji: string) => {
      if (customizeMode && customizeSlot !== null) {
        const next = [...favorites];
        next[customizeSlot] = emoji;
        setFavorites(next);
        saveFavorites(next);
        setCustomizeSlot(null);
        return;
      }
      onSelect(emoji);
      onClose();
    },
    [customizeMode, customizeSlot, favorites, onSelect, onClose],
  );

  const handleServerEmojiClick = useCallback(
    (emoji: GuildEmoji) => {
      onSelect(formatCustomEmojiToken(emoji.name, emoji.id, emoji.animated));
      onClose();
    },
    [onSelect, onClose]
  );

  // Compute clamped position for popup mode
  const popupStyle = useMemo(() => {
    if (!position) return undefined;

    const pad = 8;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    const width = Math.min(22 * 16, vw - pad * 2);
    const height = Math.min(26.25 * 16, vh - pad * 2);

    let x = position.x;
    let y = position.y;

    if (x + width + pad > vw) x = vw - width - pad;
    if (x < pad) x = pad;
    if (y + height + pad > vh) y = vh - height - pad;
    if (y < pad) y = pad;

    return {
      position: 'fixed' as const,
      left: x,
      top: y,
      zIndex: 51,
    };
  }, [position]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const emojiCellClass =
    'flex aspect-square items-center justify-center rounded-sm text-[22px] leading-none outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]';

  const pickerContent = (
    <div
      ref={pickerRef}
      className="popup-enter flex w-[min(22rem,calc(100vw-1rem))] max-h-[min(26.25rem,calc(100dvh-1rem))] flex-col overflow-hidden rounded-md border border-border-subtle bg-bg-floating shadow-lg"
      style={popupStyle}
    >
      {/* ── Frequently used ── */}
      <div className="shrink-0 border-b border-border-subtle px-3 pb-2.5 pt-3">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-section uppercase text-text-muted">Frequently used</span>
          {customizeMode ? (
            <button
              type="button"
              onClick={() => {
                setCustomizeMode(false);
                setCustomizeSlot(null);
              }}
              className="rounded-sm px-1.5 py-0.5 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
            >
              Done
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setCustomizeMode(true)}
              className="rounded-sm px-1.5 py-0.5 text-meta font-medium text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
            >
              Customize
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          {favorites.map((emoji, i) => (
            <button
              key={`fav-${i}`}
              type="button"
              onClick={() => {
                if (customizeMode) {
                  setCustomizeSlot(i);
                } else {
                  onSelect(emoji);
                  onClose();
                }
              }}
              className={cn(
                'flex h-9 flex-1 items-center justify-center rounded-sm text-2xl leading-none outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]',
                customizeMode && customizeSlot === i && 'bg-accent-tint',
              )}
              style={{
                border: customizeMode
                  ? customizeSlot === i
                    ? '2px solid var(--accent-primary)'
                    : '2px dashed var(--border-subtle)'
                  : '2px solid transparent',
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>

      {/* ── Source tabs (server vs unicode) ── */}
      {!!guildId && (
        <div className="flex shrink-0 gap-1 px-3 pt-2.5">
          {(['unicode', 'server'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                'flex-1 rounded-sm px-2 py-1.5 text-label outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                activeTab === tab
                  ? 'bg-accent-tint text-accent-primary'
                  : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
              )}
            >
              {tab === 'unicode' ? 'Unicode' : 'Space Emojis'}
            </button>
          ))}
        </div>
      )}

      {/* ── Inset search ── */}
      <div className="shrink-0 px-3 pb-1 pt-2.5">
        <div className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-2 transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-within:border-accent-primary focus-within:shadow-[var(--focus-ring-input)]">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            type="text"
            placeholder={activeTab === 'server' ? 'Search space emojis...' : 'Search emoji...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-body text-text-primary placeholder:text-text-muted outline-none"
          />
        </div>
      </div>

      {/* ── Grid ── */}
      <div
        ref={gridRef}
        onScroll={handleGridScroll}
        className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-2 pt-1"
      >
        {activeTab === 'server' ? (
          loadingServerEmojis ? (
            <div className="grid grid-cols-6 gap-1.5 p-1" aria-busy="true" aria-label="Loading space emojis">
              {Array.from({ length: 18 }).map((_, i) => (
                <Skeleton key={i} height={52} borderRadius="var(--radius-sm)" />
              ))}
            </div>
          ) : !guildId ? (
            <EmptyState
              icon={<Search size={20} />}
              title="Server emojis live in a server"
              description="Open a channel inside a community to browse and use its custom emoji."
            />
          ) : filteredServerEmojis.length === 0 ? (
            <EmptyState
              icon={<Search size={20} />}
              title={search.trim() ? 'No emoji found' : 'No custom emoji yet'}
              description={
                search.trim()
                  ? `Nothing matches "${search.trim()}" here — try a shorter term.`
                  : 'This server has not uploaded any custom emoji. Add some in Server Settings.'
              }
            />
          ) : (
            <div>
              <div className="text-section select-none px-1.5 pb-1.5 pt-2 uppercase text-text-muted">
                Server emoji
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {filteredServerEmojis.map((emoji) => (
                  <button
                    key={emoji.id}
                    type="button"
                    title={`:${emoji.name}:`}
                    onClick={() => handleServerEmojiClick(emoji)}
                    className="flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-sm px-1 py-1 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
                  >
                    <img
                      src={buildGuildEmojiImageUrl(guildId, emoji.id)}
                      alt={emoji.name}
                      loading="lazy"
                      className="h-[26px] w-[26px] object-contain"
                    />
                    <span className="max-w-full truncate text-[10px] leading-tight text-text-muted">
                      {emoji.name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          filteredCategories.map((cat, ci) => (
            <div
              key={cat.name}
              ref={(el) => {
                categoryRefs.current[ci] = el;
              }}
            >
              <div className="text-section select-none px-1.5 pb-1 pt-2 uppercase text-text-muted">
                {cat.name}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {cat.emojis.map((emoji, ei) => (
                  <button
                    key={`${cat.name}-${ei}`}
                    type="button"
                    title={emoji}
                    onClick={() => handleEmojiClick(emoji)}
                    className={emojiCellClass}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Category nav ── */}
      {!search.trim() && activeTab === 'unicode' && (
        <div className="flex shrink-0 items-center gap-0.5 border-t border-border-subtle px-1.5 py-1.5">
          {EMOJI_CATEGORIES.map((cat, i) => {
            const Icon = CATEGORY_ICONS[cat.name] ?? Smile;
            const active = activeCategory === i;
            return (
              <button
                key={cat.name}
                type="button"
                title={cat.name}
                aria-label={cat.name}
                aria-pressed={active}
                onClick={() => scrollToCategory(i)}
                className={cn(
                  'flex h-8 flex-1 items-center justify-center rounded-sm outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                  active
                    ? 'bg-accent-tint text-accent-primary'
                    : 'text-text-muted hover:bg-bg-mod-subtle hover:text-text-secondary',
                )}
              >
                <Icon size={18} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  // In popup mode, render a backdrop + fixed-position picker
  if (position) {
    return (
      <>
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
          }}
          onClick={onClose}
        />
        {pickerContent}
      </>
    );
  }

  // Inline mode: just render the picker
  return pickerContent;
}

// ---------------------------------------------------------------------------
// QuickReactBar — compact row of favorites for message hover toolbar
// ---------------------------------------------------------------------------

export function QuickReactBar({ onSelect }: { onSelect: (emoji: string) => void }) {
  const [favorites] = useState<string[]>(loadFavorites);

  return (
    <div className="flex items-center gap-0.5">
      {favorites.map((emoji, i) => (
        <button
          key={`qr-${i}`}
          type="button"
          onClick={() => onSelect(emoji)}
          className="flex h-7 w-7 items-center justify-center rounded-sm text-base leading-none outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
