/**
 * Auto-mode cache keys pinned byte for byte, captured from `main` before the
 * wrap() key path learned to reuse work across calls. A key is a cache
 * address: if one of these changes, every entry written under the old key is
 * orphaned. A change to any of them is a cache-key format change, never a
 * fixture refresh.
 *
 * MEMOISABLE_KEYS are calls whose every argument is a primitive that a wrapped
 * function may memoise. They include values that compare equal across types
 * (`1`, `true` and `'1'` key apart) or normalise to one key (`0` and `-0`,
 * `null` and `undefined`), integers at every MessagePack width, strings that
 * spell the memo's own separators, and calls at the size budget.
 * FULL_PATH_KEYS are calls a wrapped function must key in full every time:
 * NaN (its bit pattern reaches the key, and NaNs with different bits compare
 * equal), calls past the budget, and every non-primitive argument.
 */
export const PINNED_NAMESPACE = 'svc:getThing';

export interface PinnedKey {
  readonly name: string;
  readonly args: readonly unknown[];
  readonly key: string;
}

export const MEMOISABLE_KEYS: readonly PinnedKey[] = [
  {
    name: 'zero',
    args: [0],
    key: 'svc:getThing:f3255c8870de95dd7cf82fab94f78110361b999beea857dac7607a4a67522bda',
  },
  {
    name: 'negative zero (keys as zero)',
    args: [-0],
    key: 'svc:getThing:f3255c8870de95dd7cf82fab94f78110361b999beea857dac7607a4a67522bda',
  },
  {
    name: 'one',
    args: [1],
    key: 'svc:getThing:405f09a3617bcc1425ea95b9840d9c2713e3ecebd5a3227abc599317b732e21a',
  },
  {
    name: 'true (not one)',
    args: [true],
    key: 'svc:getThing:5795e127014c6f03ff42ea9aa4b7f4ba2e5e9f88c05f1b1e5f5208a068f938af',
  },
  {
    name: "'1' (not one, not true)",
    args: ['1'],
    key: 'svc:getThing:5fa7a1345ebf466f4c73cd064060f98d45cded44f6a02d080d51269e8684fb97',
  },
  {
    name: 'false',
    args: [false],
    key: 'svc:getThing:45642bb38c813d20dfba2c9f6e444a260099bab51787670f6c6dc575cfd286f7',
  },
  {
    name: 'empty string',
    args: [''],
    key: 'svc:getThing:d50ed78fece1d441a95d457297501cbbb1b3ed3103b3177c8814d05d733518fe',
  },
  {
    name: 'null',
    args: [null],
    key: 'svc:getThing:0d7f2b98ab3f6b4ed5f77038d171b680a7885ba0955b4f9283486f36acd7fd98',
  },
  {
    name: 'undefined (keys as null)',
    args: [undefined],
    key: 'svc:getThing:0d7f2b98ab3f6b4ed5f77038d171b680a7885ba0955b4f9283486f36acd7fd98',
  },
  {
    name: '-1',
    args: [-1],
    key: 'svc:getThing:5b36400732d17522549058e886a82912944e34f13ed33e7a441e7ad9fdd4e958',
  },
  {
    name: '127',
    args: [127],
    key: 'svc:getThing:ac0f6b4dbfaf65653a7e1065fc164df49d408d7c2dbb2034048d2b6391fb789c',
  },
  {
    name: '128',
    args: [128],
    key: 'svc:getThing:a0ad505468f1bc9dcf0bb8fdafe3fd7d93cb9deda061496868e393d24529788b',
  },
  {
    name: '255',
    args: [255],
    key: 'svc:getThing:19f3d44adadbcf95bebd503d23b7b4cba168172639b2af93bd3185ce094a8e7d',
  },
  {
    name: '256',
    args: [256],
    key: 'svc:getThing:1c6325ec0720d600059420897ca39330476bba18461aceee23a5d08e081a8830',
  },
  {
    name: '65535',
    args: [65535],
    key: 'svc:getThing:dc229f83f7a79a9d0445c3143dedc7359241a8205d26b9343223440e16ed54c7',
  },
  {
    name: '65536',
    args: [65536],
    key: 'svc:getThing:091ad9b1d80c23ebda95d8540377d3593e5ea00e0e6f09605671c3b7281000a8',
  },
  {
    name: '2 ** 32 - 1',
    args: [2 ** 32 - 1],
    key: 'svc:getThing:75303a983c793b3de24a9f2e2424b81f019816f743de876e832a4e60f861c38c',
  },
  {
    name: '2 ** 32',
    args: [2 ** 32],
    key: 'svc:getThing:576c4125842461ce805395a8055d6c9fbc7031dd61e2f3264fcb80a90a8dfb1c',
  },
  {
    name: '-32',
    args: [-32],
    key: 'svc:getThing:ae03dca781c8d0cae534efeabbda7a69191a80c5cb96dfd22269ffc3158fdc94',
  },
  {
    name: '-33',
    args: [-33],
    key: 'svc:getThing:baa3ce5b5cefc8d624e54896efccfec1e8061dcce88daf1f148ba1e9968f94f8',
  },
  {
    name: '-128',
    args: [-128],
    key: 'svc:getThing:9559cb3f5deaae3d21a001f2402ca55e5d6edbbfdf18406940dbe6b5b310bfb4',
  },
  {
    name: '-129',
    args: [-129],
    key: 'svc:getThing:f2c35864e43e262f6e083c9c9ab324138ec3899fa03d216b93cbe9eb1e639bc0',
  },
  {
    name: '-32768',
    args: [-32768],
    key: 'svc:getThing:977e1626532cdbc64e6312c9b47ba2f5e60b1f70dfcac0a186232e688280f06b',
  },
  {
    name: '-32769',
    args: [-32769],
    key: 'svc:getThing:2188e47f1546c720f58ae1d4c316de33a2f71c19a1c45b0ffb4be5780bf537e7',
  },
  {
    name: '-(2 ** 31)',
    args: [-(2 ** 31)],
    key: 'svc:getThing:29def4c97ae9f3b2fdeed1212a077eb8da84fb0fda9f1637b7e1d4f78cb65aa1',
  },
  {
    name: '-(2 ** 31) - 1',
    args: [-(2 ** 31) - 1],
    key: 'svc:getThing:84634e8d92e99e999c9dc25f8d5f5a5cb58d1272219685eb4c34eddc8d51f729',
  },
  {
    name: 'MAX_SAFE_INTEGER',
    args: [Number.MAX_SAFE_INTEGER],
    key: 'svc:getThing:4967314e94c7028f7000908a1721db232332afb2f8a74f00ffd5b5d455398f28',
  },
  {
    name: 'MIN_SAFE_INTEGER',
    args: [Number.MIN_SAFE_INTEGER],
    key: 'svc:getThing:b9fa2361db0f1a8818e745ea19c997e80be3d472abe13bfbde7057965bd44ce1',
  },
  {
    name: '2 ** 53',
    args: [2 ** 53],
    key: 'svc:getThing:c5f294f07b0db9b8a80bdb668bad65f04bbe2e6dbf0d052feec20008a708fc25',
  },
  {
    name: '1.5',
    args: [1.5],
    key: 'svc:getThing:d0fa16b3a6b421381518c6ff10da786942df9407348401cad2a61be9d62ffb70',
  },
  {
    name: '-1.5',
    args: [-1.5],
    key: 'svc:getThing:5bcd6d150cde322830a05b6c96d1ffdb2e9bcbc5e1b50a954d2ddb52fd20ab05',
  },
  {
    name: '0.1',
    args: [0.1],
    key: 'svc:getThing:601fc34a5ba441dc31c7e8bb8fbfa6da13948113405875e9c5a1b1ab651b8bda',
  },
  {
    name: '1e21',
    args: [1e21],
    key: 'svc:getThing:97b6305ad4c2ea79fa31f4e4c828c4c585d0f06d08ad540063d6377218de8f5b',
  },
  {
    name: 'smallest subnormal',
    args: [Number.MIN_VALUE],
    key: 'svc:getThing:fba2cfa5fa519e287a8295aace3d36845aa614c0809c0bc1cafc1f18a70b5645',
  },
  {
    name: 'MAX_VALUE',
    args: [Number.MAX_VALUE],
    key: 'svc:getThing:732194ba4b852cae1a09a02e5c43053d9a83d88a454f77d590627f837f0fb7f1',
  },
  {
    name: 'Infinity',
    args: [Infinity],
    key: 'svc:getThing:c57aa0a4a8493c4eed4aa7628076f6a0566d27a7cd4f4fe5ae2faea36a9db722',
  },
  {
    name: '-Infinity',
    args: [-Infinity],
    key: 'svc:getThing:59180977da0fa007272dc6c31e1864588317200b08d821ee00eab91224e6c3f7',
  },
  {
    name: 'ASCII string',
    args: ['user-42'],
    key: 'svc:getThing:710c2089e19019b86c273a4c8e103460c3b1323dbd72b91a8635ab8da3136d86',
  },
  {
    name: 'two-byte UTF-8',
    args: ['héllo'],
    key: 'svc:getThing:4937602fbb19bddaf0888cab307167ccb29fb5c7433e0a4b69e265aff20e5048',
  },
  {
    name: 'three-byte UTF-8',
    args: ['日本'],
    key: 'svc:getThing:aa51aba948ee727910f2f72dd65f93203b9a50dfd36e919cbb7d59c31639a51f',
  },
  {
    name: 'surrogate pair',
    args: ['\u{1F600}'],
    key: 'svc:getThing:c0eb890e36c78faa0019dbe48f72f116f6ab30b22515509a10e11f5b92bd4aeb',
  },
  {
    name: 'lone high surrogate',
    args: ['\ud800'],
    key: 'svc:getThing:94c38dc314aaebbf191e5dd60fc915a418037e5e4340d1ce0a467f18ac248ac1',
  },
  {
    name: 'lone low surrogate',
    args: ['\udc00'],
    key: 'svc:getThing:1907a650a3098c40f925d372c487ddeb78ac8c86235ab405e5df0915d78c1701',
  },
  {
    name: 'separator characters',
    args: ['a:b;c|s1:'],
    key: 'svc:getThing:de140a41c87a67b0c407f22fbd1c732ce262a3533c82f7140d9568e75d1f86c7',
  },
  {
    name: "'n1;' (not one)",
    args: ['n1;'],
    key: 'svc:getThing:149c32c27d4caf228c9999d4a9f4e5bf0d0630a10c2d12abc58688032851e5bc',
  },
  {
    name: "'s1:a' (not 'a')",
    args: ['s1:a'],
    key: 'svc:getThing:fa6688a30cbf8eaf56ac110b69ca8b8ceb138363b080d9ca33f4c663eee87584',
  },
  {
    name: '256 characters',
    args: ['a'.repeat(256)],
    key: 'svc:getThing:341a4065da18286de019547fc8461076ab1453026321f7cc5dea019eae6869d0',
  },
  {
    name: 'no arguments',
    args: [],
    key: 'svc:getThing:8064bf5f945dba521b017bb3f32b31a293a6e16944838d171ea9e77fab085e8e',
  },
  {
    name: 'the README benchmark key',
    args: ['user-42', 7, true],
    key: 'svc:getThing:199390bd8772f4b80a45b067d951d36de196ca1d2f2cb34853d6775fc1ac9a72',
  },
  {
    name: "1, '1', true",
    args: [1, '1', true],
    key: 'svc:getThing:35bc8827168134cb1e87afa829bf543221b6a3e2cec25052bf68eed56bfed6e4',
  },
  {
    name: "true, 1, '1'",
    args: [true, 1, '1'],
    key: 'svc:getThing:713570d1cf4b67228896227d3409d8b2340e6a65f1ba9ac59d8c2936b2ad374f',
  },
  {
    name: '0, -0',
    args: [0, -0],
    key: 'svc:getThing:37e0f5a753782a6bf2cba1d7212b62362f689fa1d3f08b745ae40cfc214a2af3',
  },
  {
    name: '-0, 0',
    args: [-0, 0],
    key: 'svc:getThing:37e0f5a753782a6bf2cba1d7212b62362f689fa1d3f08b745ae40cfc214a2af3',
  },
  {
    name: 'null, undefined',
    args: [null, undefined],
    key: 'svc:getThing:5de8539c155e86371a4940d8872c36b0ffc0ee8acba337602361a2234c926122',
  },
  {
    name: 'undefined, undefined',
    args: [undefined, undefined],
    key: 'svc:getThing:5de8539c155e86371a4940d8872c36b0ffc0ee8acba337602361a2234c926122',
  },
  {
    name: "'a', 'b'",
    args: ['a', 'b'],
    key: 'svc:getThing:f5a5c954e6bd74f169a73ea03b821251dffe88aa8b3c6a59b7e353baca6cecd1',
  },
  {
    name: "'ab'",
    args: ['ab'],
    key: 'svc:getThing:9726dba0a04c94109855508c65ba1e7665152346723626ed180c4345c4300104',
  },
  {
    name: "'a', 'b', ''",
    args: ['a', 'b', ''],
    key: 'svc:getThing:577fc20b1d07f537abdd7089dd36d49e6dbf5b2fd9cf8b664c2831175c73bfb0',
  },
  {
    name: "'', ''",
    args: ['', ''],
    key: 'svc:getThing:886b4f14dbd04dd1bea5d17fa0f8333d52fc822bffc673f5398e7e2be25a3b3b',
  },
  {
    name: "1, 'n2;'",
    args: [1, 'n2;'],
    key: 'svc:getThing:d073390c0ad72a335dd5282009e810380ce83d0eafd4fbafe624e015d1669070',
  },
  {
    name: "'1', 2",
    args: ['1', 2],
    key: 'svc:getThing:37f40a1396b755a3f36e2e8e8314eae479b5b98e7002d9a1836e39e9ea711ea1',
  },
  {
    name: 'Infinity, -Infinity',
    args: [Infinity, -Infinity],
    key: 'svc:getThing:e22713621d9e9e21be7597f75e3bbf814bd16d4cf6d732f3869c67b7f7a7517e',
  },
  {
    name: '1.5, 2 ** 53',
    args: [1.5, 2 ** 53],
    key: 'svc:getThing:57b1ad2e2e435a14db1a3dc530e1ae8f317aad617c9cd4b4666407c9ed640c4b',
  },
  {
    name: 'eight arguments',
    args: [1, 2, 3, 4, 5, 6, 7, 8],
    key: 'svc:getThing:63787a51ba8180105b67ac477a785b1c308c3e5059d5109836dbac6f6f98f408',
  },
  {
    name: '256 characters over two strings',
    args: ['a'.repeat(128), 'b'.repeat(128)],
    key: 'svc:getThing:14dd585677e039d9d6edb729275ca07643feaeb4fda5071ea93554a73c603967',
  },
];

export const FULL_PATH_KEYS: readonly PinnedKey[] = [
  {
    name: 'NaN',
    args: [NaN],
    key: 'svc:getThing:db074324524945013271c757d92b2d74f8c66e9407797ca84daaff3b23a512c3',
  },
  {
    name: '257 characters',
    args: ['a'.repeat(257)],
    key: 'svc:getThing:e1046b489a93bd156d961cabd26571a9c1282fb5eabdbefee8588a917789d749',
  },
  {
    name: '257 characters over two strings',
    args: ['a'.repeat(128), 'b'.repeat(129)],
    key: 'svc:getThing:ffb18ea209f47e4d80680a79a77802f321adfe0e612e792af0cff3fff6bfb874',
  },
  {
    name: 'nine arguments',
    args: [1, 2, 3, 4, 5, 6, 7, 8, 9],
    key: 'svc:getThing:5af099f42f9c0e0170628c9eb9e6f7b1c6780f17597fe4fa017e62573164bab4',
  },
  {
    name: 'object',
    args: [{ id: 1 }],
    key: 'svc:getThing:76dcf19d378cc2110909093309289d53a6b385257eeff28e172507cf4e97fa51',
  },
  {
    name: 'array',
    args: [[1, 2]],
    key: 'svc:getThing:a4a5b59ae2a884bebf2a4a8b7118e747fe9ee3f46e19eab4ed11dc9eb5f382fc',
  },
  {
    name: 'nested array',
    args: [1, [2]],
    key: 'svc:getThing:7e59353e84f6573e26908dd0aad3c94b70417a52399e9e0dd5b1b162589900a0',
  },
  {
    name: 'Date',
    args: [new Date(0)],
    key: 'svc:getThing:4ee13e6b393543a44127ecc1783ed78486dd2a03e48298e90a32f6d0f3b6df64',
  },
  {
    name: 'Map',
    args: [new Map([['a', 1]])],
    key: 'svc:getThing:8d3fead90140af27d3e0aad7ab2cf4735b1961071af3d16af3f83cedcf574c7e',
  },
  {
    name: 'Set',
    args: [new Set([1])],
    key: 'svc:getThing:64ffcba37b89bf58dad2f3cdb31859a9500722916d1fecf246e26b947ac502de',
  },
  {
    name: 'Uint8Array',
    args: [Uint8Array.of(1, 2)],
    key: 'svc:getThing:04df24b940715d0f6a344bf3c87421c63d24db5c5d784a114f09b0cbab5565bc',
  },
  {
    name: 'boxed number (keys as {})',
    args: [Object(1)],
    key: 'svc:getThing:61f45f3273572936dcd3273835cc401d0b130ead2796cf7e12d5e901966952f1',
  },
  {
    name: 'boxed string',
    args: [Object('a')],
    key: 'svc:getThing:ca2795e071b1cd3c445adaee4d8943d778d95603fc1ab2f884675432c6b3ac44',
  },
  {
    name: 'the Ir suite arguments',
    args: [42, 'user-profile', { region: 'au', tier: 3 }],
    key: 'svc:getThing:30a5eeb75eca6e1462348dd1afb37f6063fb3814f248b0115b439b7c5f23c7e7',
  },
];
