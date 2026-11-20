# Sound assets to find

Checklist for replacing the placeholder spectrogram shapes with real audio.

## Recording requirements

These apply to every asset unless the item says otherwise.

- **Format.** WAV, 48 kHz or 44.1 kHz, 16 or 24 bit, mono.
- **Dry and close.** Recorded close to the source, with little reverb and no other traffic or voices. The game adds distance, the 300 m hearing range, high-frequency loss and Doppler itself.
- **Stationary.** The source should not move past the microphone. Pass-by recordings have Doppler and a volume swell baked in, which the game would then apply twice. Use pass-bys only where noted.
- **Loops.** Continuous sounds need a seamless loop of at least 10 seconds, ideally 30 seconds or more, so repetition isn't obvious over a 180 second clip.
- **Variations.** For one-shots, get 3 to 5 takes so repeats don't sound identical.
- **License.** Must allow use in a commercial game. CC0, or a royalty-free license that covers games. Note the source and license of each file.

Good places to look: Freesound.org filtered to CC0, the Sonniss GDC free bundles, and your own field recordings in Sofia, which is the best option for sirens and trams.

## Needed now: one for every current sound source

### Ambulance
- [ ] Siren, wail mode, seamless loop
- [ ] Siren, yelp mode, seamless loop
- [ ] Air horn blast, one-shot, 3 takes

Match the siren type Sofia ambulances actually use. Check a few videos of Sofia ambulances before choosing.

### Police car
- [ ] Siren, wail mode, seamless loop
- [ ] Siren, yelp mode, seamless loop
- [ ] Siren, hi-lo two-tone, seamless loop, if Bulgarian police use it
- [ ] Short "whoop" or chirp, one-shot

As above, match what Sofia police cars use.

### Emergency vehicle body
- [ ] Car engine and tyre noise at about 50 km/h, loop, without siren

Mixed quietly under the sirens so vehicles don't sound like floating speakers.

### Tram
- [ ] Rolling on straight track at 20 to 40 km/h, loop
- [ ] Wheel squeal in a curve, one-shot, 3 to 5 takes of 2 to 5 seconds
- [ ] Warning bell or gong, one-shot, 3 takes
- [ ] Braking to a stop, one-shot
- [ ] Pulling away from a stop, motor whine rising, one-shot

Sofia runs older Tatra T6A2 trams and newer Pesa Swing trams, which sound quite different. Pick one or get both.

### Airplane
- [ ] Jet airliner on approach, steady engine rumble, loop

A distant jet is broadband rumble, so a steady recording works better than a flyover. At the current 700 m altitude the plane is outside the 300 m hearing range, so this is only needed if the plane comes lower or is exempt from the range.

### Church bells
- [ ] Full peal, 30 to 60 seconds. Alexander Nevsky Cathedral recordings exist.
- [ ] Single bell strikes, one-shots at 3 to 5 different pitches

The single strikes let the game build its own ringing patterns and timing.

### Construction site
- [ ] Jackhammer, loop, plus a few start and stop one-shots
- [ ] Angle grinder, one-shot, 3 takes of 3 to 8 seconds
- [ ] Excavator or diesel engine idle, loop
- [ ] Hammering on metal or wood, one-shots
- [ ] Reversing beeper, loop

## Needed soon: background and the target's own sounds

### City ambience beds
These fill the noise floor. Later they can be mixed by the aligned noise map, so loud bands near boulevards get more traffic roar and quiet courtyards get mostly birds.

- [ ] Distant city traffic roar, loop of 60 seconds or more
- [ ] Busy boulevard close by, loop of 60 seconds or more
- [ ] Quiet residential street or courtyard, loop of 60 seconds or more
- [ ] Park, with birds and wind in trees, loop of 60 seconds or more

### The target's phone
The recording comes from the target's phone, so their own sounds would be in it.

- [ ] Footsteps on pavement at walking pace, loop or a set of single steps
- [ ] Phone handling and pocket rustle, one-shots
- [ ] Wind on a phone microphone, loop

## Nice to have: new landmark sources

These would give players more clues to place the target.

- [ ] Trolleybus electric hum and pantograph clicks, loop. Sofia has trolleybuses.
- [ ] City bus idling and pulling away
- [ ] Car horns, one-shots, several types
- [ ] Motorbike or scooter pass-by. Pass-by recordings are fine here.
- [ ] Street musician, such as accordion or guitar, loop
- [ ] Café terrace chatter and cups, loop
- [ ] Market crowd, for the Central Market Hall area, loop
- [ ] Fountain, loop
- [ ] Pigeons and wing flaps, one-shots
- [ ] Dog barks, one-shots
- [ ] Call to prayer from Banya Bashi Mosque, which is inside the play area
- [ ] Sveta Nedelya church bells, distinct from Alexander Nevsky

## Game interface sounds

- [ ] Button click
- [ ] Select a suspect
- [ ] Accuse
- [ ] Correct answer
- [ ] Wrong answer
- [ ] Timeline scrub tick, optional
