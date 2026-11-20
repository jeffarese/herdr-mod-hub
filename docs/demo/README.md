# The README's picture

[preview.png](../../preview.png) (also the card on the herdr.dev gallery) is the real mod in the
real Herdr app, on a showcase stage: a second Herdr app on this Mac with a home of its own, every
one of Jeff's mods installed, his layout, and a made-up world around them (Sam, who works at
Acme, with agents on two machines, pull requests, servers and two notifications).

**Real:** the Herdr app, herdr-core, this repository's mod as the working tree has it, the other
mods, and the gallery: the Discover page lists what herdr.dev shares, fetched over the network
when the picture is taken.

**Made up:** every session, project, machine, pull request and server around the dialog. The
stage builds them from stand-ins; nothing of yours is read or written.

The stage is the showcase kit in `~/workspace/herdr/herdr-showcase` (its `README.md` explains
it, and `BRIEF.md` is the world every mod's picture shares). This folder holds the one piece that
is this mod's own: [showcase.sh](showcase.sh), the hook the kit runs after its cast. It opens the
Mods dialog and waits until the first cards' previews have downloaded.

## Take it again

From the repository's root:

```sh
sh docs/demo/showcase-shots.sh
```

[showcase-shots.sh](showcase-shots.sh) builds the stage with the hook, takes `preview.png` with
the kit's `shoot.sh`, shrinks it to a palette if it is over 2.5 MB ([quantize.sh](quantize.sh)),
and takes the stage down. To look before shooting, build a stage and keep it:

```sh
SHOWCASE_TFVPN=0 SHOWCASE_HOOK=$PWD/docs/demo/showcase.sh sh ~/workspace/herdr/herdr-showcase/stage.sh > /tmp/stage.txt
w=$(head -n 1 /tmp/stage.txt)
sh ~/workspace/herdr/herdr-showcase/shoot.sh "$w" preview.png
sh ~/workspace/herdr/herdr-showcase/stage.sh --down "$w"
```

(The stage's folder is read from a file: some of its processes keep `stage.sh`'s output open,
so `w=$(sh stage.sh)` waits until the stage is gone.)

- `SHOWCASE_TFVPN=0` leaves out the private VPN switch, as every public README's picture does.
- The dialog opens on the page it showed last, so a stage's first open is Discover. The
  gallery's order changes from day to day, so the cards differ from one picture to the next.
- `shoot.sh` waits until the keyboard and mouse have been still for a minute, then brings the
  stage's window forward for about two seconds. Run it when you can leave the Mac alone.
- The picture is the window at 2x, 3200 pixels wide.
