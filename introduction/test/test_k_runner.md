---
id: krunneraaaaaaaaa
coconote: true
title: test_k_runner
prereq: [welcome]
---
# wikilink tests fixture for browser

K-01 unique by filename: [[welcome]]

K-02 by title (test_wikilink_title has title AliasTitle): [[AliasTitle]]

K-03 filename outranks title (both Bravo file exists, k_outranks has title Bravo): [[Bravo]]

K-04 path disambiguation: [[kdir1/collide]] vs [[kdir2/collide]]

K-05 tag prefix disambiguation: [[math/wlink/collide]] (tag math/wlink on KFile1)

K-06 ambiguous - no match: [[totally_does_not_exist]]

K-06 ambiguous - collision: [[collide]]

K-08 heading: [[markdown#Lists]]

K-13 PDF anchor: [[test1.pdf%anchor-may-not-exist]]

K-14 md page with %: [[welcome%bad]]

K-15 current page marker only: [[#wikilink tests fixture]]

K-16 current file marker not found: [[#nope_no_heading]]

K-17 external URL: [[https://example.com]]

K-18 display alias: [[welcome|home]]

K-19 display alias with marker: [[markdown#Lists|to-lists]]

K-20 display alias with external: [[https://example.com|ext-home]]