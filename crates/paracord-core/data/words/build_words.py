#!/usr/bin/env python3
"""Rebuild the daily word lists from their public sources.

Usage:
    python3 build_words.py <sources-dir>

<sources-dir> holds the unpacked downloads listed in LICENSE-SOURCES.md:
    enable1.txt
    12dicts/            (12dicts-6.0.2.zip, unpacked)
    scowl-2020.12.07/   (scowl-2020.12.07.tar.gz, unpacked)
    dict/               (wn3.1.dict.tar.gz, unpacked)

Writes answers.txt, allowed.txt and definitions.tsv next to this script.
blocklist.txt is hand-written and read from here too.

Changing answers.txt changes the order future puzzles are drawn in. Days that
have already been played keep their word: the server stores each day's answer
the first time anyone opens it.
"""

import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIVE = re.compile(r"[a-z]{5}")

# Words ending in s that are not plurals even though the stem is also a word.
KEEP_S = {"chaos", "kudos"}


def read_words(path):
    out = set()
    with open(path, encoding="latin-1") as handle:
        for line in handle:
            word = line.strip()
            if FIVE.fullmatch(word):
                out.add(word)
    return out


def main(src):
    enable_all = set()
    with open(os.path.join(src, "enable1.txt"), encoding="latin-1") as handle:
        for line in handle:
            enable_all.add(line.strip())
    enable = {w for w in enable_all if FIVE.fullmatch(w)}

    blocked = set()
    with open(os.path.join(HERE, "blocklist.txt"), encoding="utf-8") as handle:
        for line in handle:
            word = line.split("#", 1)[0].strip()
            if word:
                if not FIVE.fullmatch(word):
                    raise SystemExit(f"blocklist entry is not five lowercase letters: {word!r}")
                blocked.add(word)

    # Answers: the 12dicts 3esl core vocabulary (public domain), five letters,
    # also in ENABLE, with regular plurals and past tenses dropped.
    core = read_words(os.path.join(src, "12dicts/American/3esl.txt")) & enable

    def plural(word):
        if word in KEEP_S or not word.endswith("s") or word.endswith(("ss", "us", "is")):
            return False
        return (
            word[:-1] in enable_all
            or (word.endswith("es") and word[:-2] in enable_all)
            or (word.endswith("ies") and word[:-3] + "y" in enable_all)
            or (word.endswith("ves") and (word[:-3] + "f" in enable_all or word[:-3] + "fe" in enable_all))
        )

    def past(word):
        if not word.endswith("ed") or word.endswith("eed"):
            return False
        return (
            word[:-2] in enable_all
            or word[:-1] in enable_all
            or (word[-3] == word[-4] and word[:-3] in enable_all)
            or (word.endswith("ied") and word[:-3] + "y" in enable_all)
        )

    answers = sorted(w for w in core if not plural(w) and not past(w) and w not in blocked)

    # Allowed guesses: ENABLE, the 12dicts game lists, and SCOWL up to size 50.
    allowed = set(enable)
    allowed |= read_words(os.path.join(src, "12dicts/American/2of12inf.txt"))
    allowed |= read_words(os.path.join(src, "12dicts/International/3of6game.txt"))
    for path in glob.glob(os.path.join(src, "scowl-2020.12.07/final/*-words.*")):
        name = os.path.basename(path)
        if not (name.startswith("english-words.") or name.startswith("american-words.")):
            continue
        if int(name.rsplit(".", 1)[1]) <= 50:
            allowed |= read_words(path)
    allowed |= set(answers)
    allowed = sorted(w for w in allowed if w not in blocked)

    definitions = wordnet_definitions(os.path.join(src, "dict"), answers)

    with open(os.path.join(HERE, "answers.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(answers) + "\n")
    with open(os.path.join(HERE, "allowed.txt"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(allowed) + "\n")
    with open(os.path.join(HERE, "definitions.tsv"), "w", encoding="utf-8") as handle:
        for word in answers:
            if word in definitions:
                pos, gloss = definitions[word]
                handle.write(f"{word}\t{pos}\t{gloss}\n")
    print(f"answers {len(answers)}, allowed {len(allowed)}, definitions {len(definitions)}")


POS_FILES = {"n": "noun", "v": "verb", "a": "adj", "r": "adv"}
POS_NAMES = {"n": "noun", "v": "verb", "a": "adjective", "r": "adverb"}
MAX_GLOSS = 90


def wordnet_definitions(dict_dir, words):
    """The gloss of the sense WordNet's tagged corpus saw most often.

    A word none of whose senses was seen in the tagged corpus gets no
    definition: WordNet's order among untagged senses is arbitrary, and a
    wrong definition is worse than none.
    """
    wanted = set(words)
    ss_pos = {"1": "n", "2": "v", "3": "a", "4": "r", "5": "a"}
    pos_order = {"n": 0, "v": 1, "a": 2, "r": 3}
    best = {}
    with open(os.path.join(dict_dir, "index.sense"), encoding="latin-1") as handle:
        for line in handle:
            key, offset, sense_number, tag_count = line.split()
            lemma, rest = key.split("%", 1)
            if lemma not in wanted:
                continue
            pos = ss_pos[rest[0]]
            rank = (-int(tag_count), int(sense_number), pos_order[pos])
            if lemma not in best or rank < best[lemma][0]:
                best[lemma] = (rank, pos, int(offset))

    out = {}
    for word in words:
        if word not in best:
            continue
        (neg_tags, _, _), pos, offset = best[word]
        if neg_tags == 0:
            continue
        gloss = read_gloss(dict_dir, pos, offset)
        if gloss and len(gloss) <= MAX_GLOSS:
            out[word] = (POS_NAMES[pos], gloss)
    return out


def read_gloss(dict_dir, pos, offset):
    with open(os.path.join(dict_dir, f"data.{POS_FILES[pos]}"), "rb") as handle:
        handle.seek(offset)
        line = handle.readline().decode("latin-1")
    gloss = line.split(" | ", 1)[1].strip()
    gloss = gloss.split('; "', 1)[0].split(";", 1)[0].strip()
    gloss = re.sub(r"^\([^)]*\)\s*", "", gloss).strip()
    gloss = gloss.replace("`", "'").replace("\t", " ")
    return gloss


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
