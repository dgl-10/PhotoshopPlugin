'use strict';

/**
 * Recorded SkinBench runner results for the areola equivalence test (generated, do not edit).
 * Source: docs/points_to_future development/skin_texture/sandbox/task20/make-areola-equivalence.js
 * Reference: SkinBench variants/runner.js runWasmVariant on the pinned binaries (Gemini: git HEAD original).
 * `request` is the hand-built contract request; `checksums` are exchange.checksums of every layer
 * on the region; `wholeDocumentCrop` is the same layers computed on the whole document and cropped.
 */
module.exports = {
  "variants": [
    {
      "id": "areola_fable",
      "variant": "fable_areola_v1",
      "fileName": "fable_areola.wasm",
      "sha256": "ab076519d68e83631322db439fefce090701aa95785bf784e8625fb9d372a864"
    },
    {
      "id": "areola_gemini",
      "variant": "gemini4_areola_v1",
      "fileName": "gemini4_areola.wasm",
      "sha256": "ff544bfe40dc2899a2fbfbc177ed668cc5088c0cacd28f09bd3600f74cfb7085"
    },
    {
      "id": "areola_astra",
      "variant": "gpt6_areola_v1",
      "fileName": "gpt6_areola.wasm",
      "sha256": "169179c3f435debc8d1b6eeb98c6da9feff8c52ae12a3893b1d2218866878d0e"
    }
  ],
  "cases": [
    {
      "id": "circle_centered",
      "document": {
        "width": 600,
        "height": 500
      },
      "pxPerMm": 4,
      "params": {
        "seed": 1,
        "azimuthDeg": 315,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              300,
              250
            ],
            "radii": [
              90,
              90
            ],
            "angleDeg": 0
          },
          "nipple": [
            300,
            250
          ],
          "nippleRadiusPx": 27
        }
      ],
      "region": {
        "x": 163,
        "y": 113,
        "width": 274,
        "height": 274
      },
      "request": {
        "width": 274,
        "height": 274,
        "document": {
          "width": 600,
          "height": 500
        },
        "rect": {
          "x": 163,
          "y": 113,
          "width": 274,
          "height": 274
        },
        "pxPerMm": 4,
        "seed": 1,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  300,
                  250
                ],
                "radii": [
                  90,
                  90
                ],
                "angleDeg": 0
              },
              "nipple": [
                300,
                250
              ],
              "nippleRadiusPx": 27
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 75076,
          "crc32": "7404ea84",
          "fnv1a": "d8df43c4"
        },
        "areola_fable_tubercles": {
          "length": 75076,
          "crc32": "695e8b77",
          "fnv1a": "aeae1809"
        },
        "areola_fable_skin": {
          "length": 75076,
          "crc32": "42b4ecb8",
          "fnv1a": "c1d89350"
        },
        "areola_astra_nipple": {
          "length": 75076,
          "crc32": "b3b232af",
          "fnv1a": "4b796525"
        },
        "areola_astra_tubercles": {
          "length": 75076,
          "crc32": "2a889a1a",
          "fnv1a": "d53db86b"
        },
        "areola_astra_skin": {
          "length": 75076,
          "crc32": "e021a916",
          "fnv1a": "115bbfd6"
        },
        "areola_gemini_nipple": {
          "length": 75076,
          "crc32": "8203cb39",
          "fnv1a": "9478ff84"
        },
        "areola_gemini_tubercles": {
          "length": 75076,
          "crc32": "17f291a5",
          "fnv1a": "44f179e7"
        },
        "areola_gemini_skin": {
          "length": 75076,
          "crc32": "5e8d1d42",
          "fnv1a": "cf48e3bf"
        }
      }
    },
    {
      "id": "rotated_ellipse_offset_nipple",
      "document": {
        "width": 640,
        "height": 520
      },
      "pxPerMm": 2.7,
      "params": {
        "seed": 42,
        "azimuthDeg": 135,
        "elevationDeg": 20
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              310.5,
              260.25
            ],
            "radii": [
              150,
              90
            ],
            "angleDeg": 28
          },
          "nipple": [
            300,
            255.5
          ],
          "nippleRadiusPx": 40
        }
      ],
      "region": {
        "x": 99,
        "y": 98,
        "width": 423,
        "height": 324
      },
      "request": {
        "width": 423,
        "height": 324,
        "document": {
          "width": 640,
          "height": 520
        },
        "rect": {
          "x": 99,
          "y": 98,
          "width": 423,
          "height": 324
        },
        "pxPerMm": 2.7,
        "seed": 42,
        "lighting": {
          "azimuthDeg": 135,
          "elevationDeg": 20
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  310.5,
                  260.25
                ],
                "radii": [
                  150,
                  90
                ],
                "angleDeg": 28
              },
              "nipple": [
                300,
                255.5
              ],
              "nippleRadiusPx": 40
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 137052,
          "crc32": "59bbfa5e",
          "fnv1a": "f78e843a"
        },
        "areola_fable_tubercles": {
          "length": 137052,
          "crc32": "699f29cc",
          "fnv1a": "e2e4bcfb"
        },
        "areola_fable_skin": {
          "length": 137052,
          "crc32": "f6933e78",
          "fnv1a": "95c86287"
        },
        "areola_astra_nipple": {
          "length": 137052,
          "crc32": "415bb4b4",
          "fnv1a": "788b55c4"
        },
        "areola_astra_tubercles": {
          "length": 137052,
          "crc32": "919b5b3b",
          "fnv1a": "8bea82ff"
        },
        "areola_astra_skin": {
          "length": 137052,
          "crc32": "16821dbd",
          "fnv1a": "4c3bc7c4"
        },
        "areola_gemini_nipple": {
          "length": 137052,
          "crc32": "e420698a",
          "fnv1a": "749a6f11"
        },
        "areola_gemini_tubercles": {
          "length": 137052,
          "crc32": "b2b94fbb",
          "fnv1a": "0d62ce73"
        },
        "areola_gemini_skin": {
          "length": 137052,
          "crc32": "17334e6f",
          "fnv1a": "6676b0a4"
        }
      }
    },
    {
      "id": "two_areolas_one_rotated",
      "document": {
        "width": 900,
        "height": 500
      },
      "pxPerMm": 1.6,
      "params": {
        "seed": 7,
        "azimuthDeg": 0,
        "elevationDeg": 80
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              250,
              250
            ],
            "radii": [
              100,
              100
            ],
            "angleDeg": 0
          },
          "nipple": [
            250,
            250
          ],
          "nippleRadiusPx": 30
        },
        {
          "areola": {
            "center": [
              650,
              260
            ],
            "radii": [
              120,
              70
            ],
            "angleDeg": 35
          },
          "nipple": [
            655,
            255
          ],
          "nippleRadiusPx": 34
        }
      ],
      "region": {
        "x": 98,
        "y": 98,
        "width": 714,
        "height": 304
      },
      "request": {
        "width": 714,
        "height": 304,
        "document": {
          "width": 900,
          "height": 500
        },
        "rect": {
          "x": 98,
          "y": 98,
          "width": 714,
          "height": 304
        },
        "pxPerMm": 1.6,
        "seed": 7,
        "lighting": {
          "azimuthDeg": 0,
          "elevationDeg": 80
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  250,
                  250
                ],
                "radii": [
                  100,
                  100
                ],
                "angleDeg": 0
              },
              "nipple": [
                250,
                250
              ],
              "nippleRadiusPx": 30
            },
            {
              "areola": {
                "center": [
                  650,
                  260
                ],
                "radii": [
                  120,
                  70
                ],
                "angleDeg": 35
              },
              "nipple": [
                655,
                255
              ],
              "nippleRadiusPx": 34
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 217056,
          "crc32": "1c719127",
          "fnv1a": "3dd223ce"
        },
        "areola_fable_tubercles": {
          "length": 217056,
          "crc32": "fcdca1fb",
          "fnv1a": "47731f2d"
        },
        "areola_fable_skin": {
          "length": 217056,
          "crc32": "55c14da1",
          "fnv1a": "4fb04a12"
        },
        "areola_astra_nipple": {
          "length": 217056,
          "crc32": "d60388c9",
          "fnv1a": "a2224e4b"
        },
        "areola_astra_tubercles": {
          "length": 217056,
          "crc32": "55e521f9",
          "fnv1a": "8a424b6c"
        },
        "areola_astra_skin": {
          "length": 217056,
          "crc32": "5b88544c",
          "fnv1a": "7c715994"
        },
        "areola_gemini_nipple": {
          "length": 217056,
          "crc32": "4c5e7c37",
          "fnv1a": "1eda48b2"
        },
        "areola_gemini_tubercles": {
          "length": 217056,
          "crc32": "9747c57d",
          "fnv1a": "f75a635f"
        },
        "areola_gemini_skin": {
          "length": 217056,
          "crc32": "037683e7",
          "fnv1a": "660e3efc"
        }
      }
    },
    {
      "id": "far_from_origin_3000x2200",
      "document": {
        "width": 3000,
        "height": 2200
      },
      "pxPerMm": 8,
      "params": {
        "seed": 4294967295,
        "azimuthDeg": 315,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              2400,
              1700
            ],
            "radii": [
              130,
              100
            ],
            "angleDeg": 12
          },
          "nipple": [
            2395.5,
            1698
          ],
          "nippleRadiusPx": 38
        }
      ],
      "region": {
        "x": 2204,
        "y": 1545,
        "width": 392,
        "height": 310
      },
      "request": {
        "width": 392,
        "height": 310,
        "document": {
          "width": 3000,
          "height": 2200
        },
        "rect": {
          "x": 2204,
          "y": 1545,
          "width": 392,
          "height": 310
        },
        "pxPerMm": 8,
        "seed": 4294967295,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  2400,
                  1700
                ],
                "radii": [
                  130,
                  100
                ],
                "angleDeg": 12
              },
              "nipple": [
                2395.5,
                1698
              ],
              "nippleRadiusPx": 38
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 121520,
          "crc32": "a852ca4f",
          "fnv1a": "11f204c0"
        },
        "areola_fable_tubercles": {
          "length": 121520,
          "crc32": "f479aaeb",
          "fnv1a": "9c3b53ce"
        },
        "areola_fable_skin": {
          "length": 121520,
          "crc32": "2e3f45fa",
          "fnv1a": "ea59640d"
        },
        "areola_astra_nipple": {
          "length": 121520,
          "crc32": "ffb2990a",
          "fnv1a": "e5831aeb"
        },
        "areola_astra_tubercles": {
          "length": 121520,
          "crc32": "f7e331fc",
          "fnv1a": "74fc2345"
        },
        "areola_astra_skin": {
          "length": 121520,
          "crc32": "737a8885",
          "fnv1a": "6ab6cae5"
        },
        "areola_gemini_nipple": {
          "length": 121520,
          "crc32": "f42ee421",
          "fnv1a": "4342c819"
        },
        "areola_gemini_tubercles": {
          "length": 121520,
          "crc32": "54454469",
          "fnv1a": "cbe827e5"
        },
        "areola_gemini_skin": {
          "length": 121520,
          "crc32": "a91e7f41",
          "fnv1a": "2a461fb8"
        }
      }
    },
    {
      "id": "scale_1.6_seed_0",
      "document": {
        "width": 500,
        "height": 400
      },
      "pxPerMm": 1.6,
      "params": {
        "seed": 0,
        "azimuthDeg": 0,
        "elevationDeg": 20
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              250,
              200
            ],
            "radii": [
              70,
              60
            ],
            "angleDeg": 5
          },
          "nipple": [
            251,
            199
          ],
          "nippleRadiusPx": 21
        }
      ],
      "region": {
        "x": 143,
        "y": 107,
        "width": 214,
        "height": 186
      },
      "request": {
        "width": 214,
        "height": 186,
        "document": {
          "width": 500,
          "height": 400
        },
        "rect": {
          "x": 143,
          "y": 107,
          "width": 214,
          "height": 186
        },
        "pxPerMm": 1.6,
        "seed": 0,
        "lighting": {
          "azimuthDeg": 0,
          "elevationDeg": 20
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  250,
                  200
                ],
                "radii": [
                  70,
                  60
                ],
                "angleDeg": 5
              },
              "nipple": [
                251,
                199
              ],
              "nippleRadiusPx": 21
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 39804,
          "crc32": "692fd386",
          "fnv1a": "f5a2fe49"
        },
        "areola_fable_tubercles": {
          "length": 39804,
          "crc32": "394fa96a",
          "fnv1a": "22ab8161"
        },
        "areola_fable_skin": {
          "length": 39804,
          "crc32": "bcb71210",
          "fnv1a": "381097c0"
        },
        "areola_astra_nipple": {
          "length": 39804,
          "crc32": "3cedebf5",
          "fnv1a": "e2a35f06"
        },
        "areola_astra_tubercles": {
          "length": 39804,
          "crc32": "5dc16eac",
          "fnv1a": "26907fff"
        },
        "areola_astra_skin": {
          "length": 39804,
          "crc32": "ca645668",
          "fnv1a": "696ea60d"
        },
        "areola_gemini_nipple": {
          "length": 39804,
          "crc32": "d3ce1339",
          "fnv1a": "6cd130e2"
        },
        "areola_gemini_tubercles": {
          "length": 39804,
          "crc32": "763be7c8",
          "fnv1a": "73611a06"
        },
        "areola_gemini_skin": {
          "length": 39804,
          "crc32": "69cd276f",
          "fnv1a": "887123ed"
        }
      }
    },
    {
      "id": "scale_2.7_seed_max",
      "document": {
        "width": 600,
        "height": 500
      },
      "pxPerMm": 2.7,
      "params": {
        "seed": 4294967295,
        "azimuthDeg": 135,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              280,
              240
            ],
            "radii": [
              110,
              85
            ],
            "angleDeg": 60
          },
          "nipple": [
            284,
            236
          ],
          "nippleRadiusPx": 33
        }
      ],
      "region": {
        "x": 140,
        "y": 81,
        "width": 280,
        "height": 318
      },
      "request": {
        "width": 280,
        "height": 318,
        "document": {
          "width": 600,
          "height": 500
        },
        "rect": {
          "x": 140,
          "y": 81,
          "width": 280,
          "height": 318
        },
        "pxPerMm": 2.7,
        "seed": 4294967295,
        "lighting": {
          "azimuthDeg": 135,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  280,
                  240
                ],
                "radii": [
                  110,
                  85
                ],
                "angleDeg": 60
              },
              "nipple": [
                284,
                236
              ],
              "nippleRadiusPx": 33
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 89040,
          "crc32": "0ccd9559",
          "fnv1a": "fa4c963f"
        },
        "areola_fable_tubercles": {
          "length": 89040,
          "crc32": "fce41fda",
          "fnv1a": "92289134"
        },
        "areola_fable_skin": {
          "length": 89040,
          "crc32": "1dc9d948",
          "fnv1a": "6794f90b"
        },
        "areola_astra_nipple": {
          "length": 89040,
          "crc32": "98631f74",
          "fnv1a": "85c2ea2a"
        },
        "areola_astra_tubercles": {
          "length": 89040,
          "crc32": "9d9c06f0",
          "fnv1a": "e8bd8729"
        },
        "areola_astra_skin": {
          "length": 89040,
          "crc32": "6c047e71",
          "fnv1a": "2302a68f"
        },
        "areola_gemini_nipple": {
          "length": 89040,
          "crc32": "4af66bf7",
          "fnv1a": "e1262691"
        },
        "areola_gemini_tubercles": {
          "length": 89040,
          "crc32": "6ef6ead0",
          "fnv1a": "66313486"
        },
        "areola_gemini_skin": {
          "length": 89040,
          "crc32": "6e030b6d",
          "fnv1a": "f26ccfca"
        }
      }
    },
    {
      "id": "scale_4_low_light",
      "document": {
        "width": 700,
        "height": 600
      },
      "pxPerMm": 4,
      "params": {
        "seed": 2026,
        "azimuthDeg": 315,
        "elevationDeg": 20
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              350,
              300
            ],
            "radii": [
              160,
              120
            ],
            "angleDeg": 140
          },
          "nipple": [
            345,
            305
          ],
          "nippleRadiusPx": 48
        }
      ],
      "region": {
        "x": 130,
        "y": 91,
        "width": 440,
        "height": 418
      },
      "request": {
        "width": 440,
        "height": 418,
        "document": {
          "width": 700,
          "height": 600
        },
        "rect": {
          "x": 130,
          "y": 91,
          "width": 440,
          "height": 418
        },
        "pxPerMm": 4,
        "seed": 2026,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 20
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  350,
                  300
                ],
                "radii": [
                  160,
                  120
                ],
                "angleDeg": 140
              },
              "nipple": [
                345,
                305
              ],
              "nippleRadiusPx": 48
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 183920,
          "crc32": "aa7c6bc5",
          "fnv1a": "c0678d80"
        },
        "areola_fable_tubercles": {
          "length": 183920,
          "crc32": "275b8d9b",
          "fnv1a": "87cf4d02"
        },
        "areola_fable_skin": {
          "length": 183920,
          "crc32": "1c2b2ff1",
          "fnv1a": "826c4bb3"
        },
        "areola_astra_nipple": {
          "length": 183920,
          "crc32": "899232ee",
          "fnv1a": "3f2de779"
        },
        "areola_astra_tubercles": {
          "length": 183920,
          "crc32": "0386feb3",
          "fnv1a": "54e8ae53"
        },
        "areola_astra_skin": {
          "length": 183920,
          "crc32": "0d5cb995",
          "fnv1a": "7da3993e"
        },
        "areola_gemini_nipple": {
          "length": 183920,
          "crc32": "03f14c05",
          "fnv1a": "fed0f082"
        },
        "areola_gemini_tubercles": {
          "length": 183920,
          "crc32": "e2f636b2",
          "fnv1a": "e7a41ebd"
        },
        "areola_gemini_skin": {
          "length": 183920,
          "crc32": "0c9068ca",
          "fnv1a": "eac257a4"
        }
      }
    },
    {
      "id": "scale_8_high_light",
      "document": {
        "width": 800,
        "height": 700
      },
      "pxPerMm": 8,
      "params": {
        "seed": 99,
        "azimuthDeg": 135,
        "elevationDeg": 80
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              400,
              350
            ],
            "radii": [
              200,
              150
            ],
            "angleDeg": 90
          },
          "nipple": [
            400,
            350
          ],
          "nippleRadiusPx": 60
        }
      ],
      "region": {
        "x": 173,
        "y": 48,
        "width": 454,
        "height": 604
      },
      "request": {
        "width": 454,
        "height": 604,
        "document": {
          "width": 800,
          "height": 700
        },
        "rect": {
          "x": 173,
          "y": 48,
          "width": 454,
          "height": 604
        },
        "pxPerMm": 8,
        "seed": 99,
        "lighting": {
          "azimuthDeg": 135,
          "elevationDeg": 80
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  400,
                  350
                ],
                "radii": [
                  200,
                  150
                ],
                "angleDeg": 90
              },
              "nipple": [
                400,
                350
              ],
              "nippleRadiusPx": 60
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 274216,
          "crc32": "01611c98",
          "fnv1a": "401a7c39"
        },
        "areola_fable_tubercles": {
          "length": 274216,
          "crc32": "f1e54b43",
          "fnv1a": "ad0016ba"
        },
        "areola_fable_skin": {
          "length": 274216,
          "crc32": "2c5c19ce",
          "fnv1a": "e8e08d65"
        },
        "areola_astra_nipple": {
          "length": 274216,
          "crc32": "83496897",
          "fnv1a": "e9d286da"
        },
        "areola_astra_tubercles": {
          "length": 274216,
          "crc32": "6b68f8fd",
          "fnv1a": "8af3be74"
        },
        "areola_astra_skin": {
          "length": 274216,
          "crc32": "a447e0bc",
          "fnv1a": "56ac4d4e"
        },
        "areola_gemini_nipple": {
          "length": 274216,
          "crc32": "57d0615a",
          "fnv1a": "9ad8f6ad"
        },
        "areola_gemini_tubercles": {
          "length": 274216,
          "crc32": "4b2ea823",
          "fnv1a": "c876502e"
        },
        "areola_gemini_skin": {
          "length": 274216,
          "crc32": "59c9e4e2",
          "fnv1a": "f6e689cb"
        }
      }
    },
    {
      "id": "strength_2.5",
      "document": {
        "width": 600,
        "height": 500
      },
      "pxPerMm": 4,
      "params": {
        "seed": 5,
        "azimuthDeg": 315,
        "elevationDeg": 45
      },
      "areolaStrength": 2.5,
      "areolas": [
        {
          "areola": {
            "center": [
              300,
              250
            ],
            "radii": [
              100,
              80
            ],
            "angleDeg": 20
          },
          "nipple": [
            302,
            249
          ],
          "nippleRadiusPx": 30
        }
      ],
      "region": {
        "x": 151,
        "y": 124,
        "width": 298,
        "height": 252
      },
      "request": {
        "width": 298,
        "height": 252,
        "document": {
          "width": 600,
          "height": 500
        },
        "rect": {
          "x": 151,
          "y": 124,
          "width": 298,
          "height": 252
        },
        "pxPerMm": 4,
        "seed": 5,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  300,
                  250
                ],
                "radii": [
                  100,
                  80
                ],
                "angleDeg": 20
              },
              "nipple": [
                302,
                249
              ],
              "nippleRadiusPx": 30
            }
          ]
        },
        "params": {
          "strength": 2.5,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 75096,
          "crc32": "d2845d18",
          "fnv1a": "830e26e8"
        },
        "areola_fable_tubercles": {
          "length": 75096,
          "crc32": "3697e305",
          "fnv1a": "3b0a6357"
        },
        "areola_fable_skin": {
          "length": 75096,
          "crc32": "414c6700",
          "fnv1a": "cc83d4da"
        },
        "areola_astra_nipple": {
          "length": 75096,
          "crc32": "925a9b4d",
          "fnv1a": "a8bc6209"
        },
        "areola_astra_tubercles": {
          "length": 75096,
          "crc32": "e9555ccb",
          "fnv1a": "d245fdb3"
        },
        "areola_astra_skin": {
          "length": 75096,
          "crc32": "bbe085f8",
          "fnv1a": "9064dbe2"
        },
        "areola_gemini_nipple": {
          "length": 75096,
          "crc32": "b21cf86a",
          "fnv1a": "e05a14a4"
        },
        "areola_gemini_tubercles": {
          "length": 75096,
          "crc32": "a833c3ee",
          "fnv1a": "66735f45"
        },
        "areola_gemini_skin": {
          "length": 75096,
          "crc32": "3858830b",
          "fnv1a": "505d0d6e"
        }
      }
    },
    {
      "id": "clipped_left_edge",
      "document": {
        "width": 400,
        "height": 400
      },
      "pxPerMm": 4,
      "params": {
        "seed": 11,
        "azimuthDeg": 315,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              30,
              200
            ],
            "radii": [
              120,
              100
            ],
            "angleDeg": 20
          },
          "nipple": [
            34,
            198
          ],
          "nippleRadiusPx": 36
        }
      ],
      "region": {
        "x": 0,
        "y": 44,
        "width": 209,
        "height": 312
      },
      "request": {
        "width": 209,
        "height": 312,
        "document": {
          "width": 400,
          "height": 400
        },
        "rect": {
          "x": 0,
          "y": 44,
          "width": 209,
          "height": 312
        },
        "pxPerMm": 4,
        "seed": 11,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  30,
                  200
                ],
                "radii": [
                  120,
                  100
                ],
                "angleDeg": 20
              },
              "nipple": [
                34,
                198
              ],
              "nippleRadiusPx": 36
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 65208,
          "crc32": "8108f26b",
          "fnv1a": "6066d9f2"
        },
        "areola_fable_tubercles": {
          "length": 65208,
          "crc32": "27758f35",
          "fnv1a": "bc36bf3f"
        },
        "areola_fable_skin": {
          "length": 65208,
          "crc32": "c7a2df20",
          "fnv1a": "2b836f41"
        },
        "areola_astra_nipple": {
          "length": 65208,
          "crc32": "0192a5fc",
          "fnv1a": "8b7c6b8d"
        },
        "areola_astra_tubercles": {
          "length": 65208,
          "crc32": "3164f2ba",
          "fnv1a": "e6599a56"
        },
        "areola_astra_skin": {
          "length": 65208,
          "crc32": "e2f33c71",
          "fnv1a": "980a79ff"
        },
        "areola_gemini_nipple": {
          "length": 65208,
          "crc32": "65f1c7b0",
          "fnv1a": "b861d529"
        },
        "areola_gemini_tubercles": {
          "length": 65208,
          "crc32": "c64c92f2",
          "fnv1a": "61c4fae8"
        },
        "areola_gemini_skin": {
          "length": 65208,
          "crc32": "26058975",
          "fnv1a": "5eba6459"
        }
      }
    },
    {
      "id": "clipped_corner",
      "document": {
        "width": 400,
        "height": 300
      },
      "pxPerMm": 2.7,
      "params": {
        "seed": 12,
        "azimuthDeg": 0,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              370,
              25
            ],
            "radii": [
              100,
              80
            ],
            "angleDeg": -35
          },
          "nipple": [
            366,
            28
          ],
          "nippleRadiusPx": 30
        }
      ],
      "region": {
        "x": 227,
        "y": 0,
        "width": 173,
        "height": 158
      },
      "request": {
        "width": 173,
        "height": 158,
        "document": {
          "width": 400,
          "height": 300
        },
        "rect": {
          "x": 227,
          "y": 0,
          "width": 173,
          "height": 158
        },
        "pxPerMm": 2.7,
        "seed": 12,
        "lighting": {
          "azimuthDeg": 0,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  370,
                  25
                ],
                "radii": [
                  100,
                  80
                ],
                "angleDeg": -35
              },
              "nipple": [
                366,
                28
              ],
              "nippleRadiusPx": 30
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 27334,
          "crc32": "ac43aefa",
          "fnv1a": "868e395a"
        },
        "areola_fable_tubercles": {
          "length": 27334,
          "crc32": "9c533154",
          "fnv1a": "c9cea439"
        },
        "areola_fable_skin": {
          "length": 27334,
          "crc32": "612842a8",
          "fnv1a": "d103aa21"
        },
        "areola_astra_nipple": {
          "length": 27334,
          "crc32": "5be428cb",
          "fnv1a": "f923177f"
        },
        "areola_astra_tubercles": {
          "length": 27334,
          "crc32": "f742d545",
          "fnv1a": "c200dc4f"
        },
        "areola_astra_skin": {
          "length": 27334,
          "crc32": "940a69fd",
          "fnv1a": "7b04bb47"
        },
        "areola_gemini_nipple": {
          "length": 27334,
          "crc32": "5180076a",
          "fnv1a": "f9d47b33"
        },
        "areola_gemini_tubercles": {
          "length": 27334,
          "crc32": "2b2951d7",
          "fnv1a": "4c1883c4"
        },
        "areola_gemini_skin": {
          "length": 27334,
          "crc32": "12ee8d5b",
          "fnv1a": "4a7760a0"
        }
      }
    },
    {
      "id": "whole_vs_region",
      "document": {
        "width": 800,
        "height": 600
      },
      "pxPerMm": 4,
      "params": {
        "seed": 31,
        "azimuthDeg": 315,
        "elevationDeg": 45
      },
      "areolaStrength": 1,
      "areolas": [
        {
          "areola": {
            "center": [
              520,
              380
            ],
            "radii": [
              110,
              80
            ],
            "angleDeg": 28
          },
          "nipple": [
            517,
            383
          ],
          "nippleRadiusPx": 33
        }
      ],
      "region": {
        "x": 361,
        "y": 246,
        "width": 318,
        "height": 268
      },
      "request": {
        "width": 318,
        "height": 268,
        "document": {
          "width": 800,
          "height": 600
        },
        "rect": {
          "x": 361,
          "y": 246,
          "width": 318,
          "height": 268
        },
        "pxPerMm": 4,
        "seed": 31,
        "lighting": {
          "azimuthDeg": 315,
          "elevationDeg": 45
        },
        "fields": {
          "areolas": [
            {
              "areola": {
                "center": [
                  520,
                  380
                ],
                "radii": [
                  110,
                  80
                ],
                "angleDeg": 28
              },
              "nipple": [
                517,
                383
              ],
              "nippleRadiusPx": 33
            }
          ]
        },
        "params": {
          "strength": 1,
          "nippleStrength": 1,
          "tubercleStrength": 1,
          "skinStrength": 1,
          "wrinkle": 1
        }
      },
      "layers": {
        "areola_fable_nipple": "areola_nipple",
        "areola_fable_tubercles": "areola_tubercles",
        "areola_fable_skin": "areola_skin",
        "areola_astra_nipple": "gpt6_areola_nipple",
        "areola_astra_tubercles": "gpt6_areola_tubercles",
        "areola_astra_skin": "gpt6_areola_skin",
        "areola_gemini_nipple": "areola_nipple",
        "areola_gemini_tubercles": "areola_tubercles",
        "areola_gemini_skin": "areola_skin"
      },
      "checksums": {
        "areola_fable_nipple": {
          "length": 85224,
          "crc32": "942956ad",
          "fnv1a": "a69e5882"
        },
        "areola_fable_tubercles": {
          "length": 85224,
          "crc32": "527b3cd0",
          "fnv1a": "c0e9d6fa"
        },
        "areola_fable_skin": {
          "length": 85224,
          "crc32": "54a11668",
          "fnv1a": "f6519587"
        },
        "areola_astra_nipple": {
          "length": 85224,
          "crc32": "c3921e08",
          "fnv1a": "aaa40de0"
        },
        "areola_astra_tubercles": {
          "length": 85224,
          "crc32": "45eeff3b",
          "fnv1a": "2246e2db"
        },
        "areola_astra_skin": {
          "length": 85224,
          "crc32": "d66f9e3c",
          "fnv1a": "2c2f0082"
        },
        "areola_gemini_nipple": {
          "length": 85224,
          "crc32": "534fad8d",
          "fnv1a": "058ceb85"
        },
        "areola_gemini_tubercles": {
          "length": 85224,
          "crc32": "224d52cd",
          "fnv1a": "c71ab1df"
        },
        "areola_gemini_skin": {
          "length": 85224,
          "crc32": "cdfad6b2",
          "fnv1a": "02631063"
        }
      },
      "wholeDocumentCrop": {
        "areola_fable_nipple": {
          "length": 85224,
          "crc32": "942956ad",
          "fnv1a": "a69e5882"
        },
        "areola_fable_tubercles": {
          "length": 85224,
          "crc32": "527b3cd0",
          "fnv1a": "c0e9d6fa"
        },
        "areola_fable_skin": {
          "length": 85224,
          "crc32": "54a11668",
          "fnv1a": "f6519587"
        },
        "areola_astra_nipple": {
          "length": 85224,
          "crc32": "c3921e08",
          "fnv1a": "aaa40de0"
        },
        "areola_astra_tubercles": {
          "length": 85224,
          "crc32": "45eeff3b",
          "fnv1a": "2246e2db"
        },
        "areola_astra_skin": {
          "length": 85224,
          "crc32": "d66f9e3c",
          "fnv1a": "2c2f0082"
        },
        "areola_gemini_nipple": {
          "length": 85224,
          "crc32": "534fad8d",
          "fnv1a": "058ceb85"
        },
        "areola_gemini_tubercles": {
          "length": 85224,
          "crc32": "224d52cd",
          "fnv1a": "c71ab1df"
        },
        "areola_gemini_skin": {
          "length": 85224,
          "crc32": "cdfad6b2",
          "fnv1a": "02631063"
        }
      }
    }
  ]
};
