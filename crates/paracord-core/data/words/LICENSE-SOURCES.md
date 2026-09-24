# Daily word lists: sources and licenses

The daily word add-on ships three generated files, compiled into the server with
`include_str!`:

| File | What it is | Built from |
|---|---|---|
| `answers.txt` | 1,973 familiar five-letter words the daily answer is drawn from | 12dicts `3esl` (public domain), kept only when also in ENABLE |
| `allowed.txt` | 8,685 words accepted as a guess (every answer included) | ENABLE (public domain), 12dicts `2of12inf` and `3of6game`, SCOWL up to size 50 |
| `definitions.tsv` | A short definition for 1,305 of the answers | WordNet 3.1 |

`blocklist.txt` is written by hand for Paracord (no outside source). Its words are
removed from both lists. `build_words.py` regenerates the three files from the
downloads below (`python3 build_words.py <folder with the unpacked downloads>`).

Answers also drop regular plurals ("books") and past tenses ("armed") whose stem
is itself a word. A word gets a definition only when WordNet's tagged corpus saw
one of its senses at least once (the most frequent one is used) and the gloss is
at most 90 characters; the rest show no definition.

## Sources

### ENABLE (Enhanced North American Benchmark Lexicon)
- Downloaded from <https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt>
  (sha256 `3f16130220645692ed49c7134e24a18504c2ca55b3c012f7290e3e77c63b1a89`).
- License: public domain. The ENABLE list was placed in the public domain by its
  compiler, Mendel Cooper.

### 12dicts 6.0.2 (Alan Beale)
- Downloaded from <http://downloads.sourceforge.net/wordlist/12dicts-6.0.2.zip>
  (sha256 `64ac1d35acb66b550c7ebc56e080b62e0bad8f5984d72059dc2e05ac48780e52`),
  linked from <http://wordlist.aspell.net/12dicts/>.
- Files used: `American/3esl.txt`, `American/2of12inf.txt`, `International/3of6game.txt`.
- License: "The 12dicts lists were compiled by Alan Beale. I explicitly release them
  to the public domain, but request acknowledgment of their use." Acknowledged here
  with thanks. `2of12inf` depends on AGID, whose notice follows:

  > Copyright 2000 by Kevin Atkinson
  >
  > Permission to use, copy, modify, distribute and sell this database, the
  > associated scripts, the output created form the scripts and its documentation
  > for any purpose is hereby granted without fee, provided that the above
  > copyright notice appears in all copies and that both that copyright notice and
  > this permission notice appear in supporting documentation. Kevin Atkinson makes
  > no representations about the suitability of this array for any purpose. It is
  > provided "as is" without express or implied warranty.

### SCOWL 2020.12.07 (Spell Checker Oriented Word Lists, Kevin Atkinson)
- Downloaded from <http://downloads.sourceforge.net/wordlist/scowl-2020.12.07.tar.gz>
  (sha256 `5587667caa20c4891390c2d42dbb4d5c4c3f41bee77af1457ece3ba23fb859cc`).
- Files used: `final/english-words.{10..50}` and `final/american-words.{10..50}`.
- License (from SCOWL's `Copyright` file; its component sources are public domain
  or carry the same kind of notice):

  > Copyright 2000-2018 by Kevin Atkinson
  >
  > Permission to use, copy, modify, distribute and sell these word lists, the
  > associated scripts, the output created from the scripts, and its documentation
  > for any purpose is hereby granted without fee, provided that the above
  > copyright notice appears in all copies and that both that copyright notice and
  > this permission notice appear in supporting documentation. Kevin Atkinson makes
  > no representations about the suitability of this array for any purpose. It is
  > provided "as is" without express or implied warranty.

### WordNet 3.1 (Princeton University)
- Downloaded from <https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz>
  (sha256 `3f7d8be8ef6ecc7167d39b10d66954ec734280b5bdcd57f7d9eafe429d11c22a`).
- Files used: `index.sense`, `data.noun`, `data.verb`, `data.adj`, `data.adv`.
- License:

  > This software and database is being provided to you, the LICENSEE, by
  > Princeton University under the following license. By obtaining, using and/or
  > copying this software and database, you agree that you have read, understood,
  > and will comply with these terms and conditions.:
  >
  > Permission to use, copy, modify and distribute this software and database and
  > its documentation for any purpose and without fee or royalty is hereby granted,
  > provided that you agree to comply with the following copyright notice and
  > statements, including the disclaimer, and that the same appear on ALL copies of
  > the software, database and documentation, including modifications that you
  > make for internal use or for distribution.
  >
  > WordNet 3.1 Copyright 2011 by Princeton University. All rights reserved.
  >
  > THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND PRINCETON UNIVERSITY MAKES
  > NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED. BY WAY OF EXAMPLE, BUT
  > NOT LIMITATION, PRINCETON UNIVERSITY MAKES NO REPRESENTATIONS OR WARRANTIES OF
  > MERCHANT- ABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE
  > LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE ANY THIRD PARTY
  > PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.
  >
  > The name of Princeton University or Princeton may not be used in advertising or
  > publicity pertaining to distribution of the software and/or database. Title to
  > copyright in this software, database and any associated documentation shall at
  > all times remain with Princeton University and LICENSEE agrees to preserve same.
