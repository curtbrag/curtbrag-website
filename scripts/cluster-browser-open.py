#!/usr/bin/env python3
"""Request one browser navigation or Termux return; never verify a screen."""

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import pathlib
import posixpath
import re
import shutil
import stat
import subprocess
import sys
from urllib.parse import quote, urlsplit, urlunsplit


TIMEOUT_SECONDS = 20
DESKTOP_OBSERVATION_SECONDS = 3
MAX_URL_LENGTH = 2048
ANDROID_NATIVE_TIMEOUT_SECONDS = 15
# BEGIN PINNED ANDROID DEX (generated from scripts/android/CurtStartActivityWait.java)
ANDROID_NATIVE_SHA256 = '7a9697f4ccbbb4a42ab6b445b270f173b9c65b14da5d269b71fadb6691b463b1'
ANDROID_NATIVE_DEX_B64 = 'ZGV4CjAzOQAiWxnFLkDNjf4kEz3hvExumlshGRBNQvBENwAAcAAAAHhWNBIAAAAAAAAAAHQ2AAARAQAAcAAAADAAAAC0BAAAMAAAAHQFAAAPAAAAtAcAAE4AAAAsCAAABAAAAJwKAAAoLAAAHAsAAPgfAAANIAAAECAAABUgAAAYIAAAHSAAACMgAAAwIAAATiAAAIogAAAEIQAAGSEAACshAABSIQAAgyEAAJshAAC3IQAAwCEAANchAADgIQAA6iEAAPchAAAPIgAAQSIAAEQiAABMIgAAUCIAAGEiAACOIgAAkSIAAJUiAACuIgAAxCIAAOAiAADwIgAA8yIAAPciAAD8IgAAACMAAAMjAAAHIwAACiMAAA4jAAApIwAARCMAAHAjAACJIwAAjSMAAJIjAACWIwAAmyMAAJ8jAACkIwAAqSMAALEjAAC1IwAA2SMAAP4jAAAeJAAAQSQAAGAkAAB8JAAAkyQAAK0kAADAJAAA0yQAAOokAAAQJQAAMyUAAEglAABaJQAAbiUAAIQlAACjJQAAtyUAANIlAADmJQAA+iUAABEmAAA8JgAAXSYAAHgmAACnJgAAwyYAANMmAADpJgAA+yYAAA8nAAAwJwAAUScAAHwnAACfJwAAwCcAAOknAAAAKAAAJSgAAEEoAABsKAAAdSgAAKUoAADAKAAA2igAAOAoAADzKAAAHikAACcpAAAwKQAAPykAAFcpAABmKQAAeykAAKEpAACyKQAAuCkAAM0pAADdKQAA6SkAAAMqAAAGKgAACioAACMqAAAnKgAAKyoAADAqAAA2KgAAOioAAD8qAABTKgAAYSoAAGQqAABoKgAAayoAAHMqAACHKgAAnCoAALEqAADXKgAA2yoAAOcqAAD0KgAA/ioAAAsrAAAVKwAAMisAAFcrAAB4KwAAlCsAAK0rAADPKwAA7ysAAAYsAAAgLAAAOCwAAFcsAABwLAAAiCwAAKQsAADALAAA4iwAAPMsAAANLQAAIC0AADQtAABHLQAAWy0AAGMtAAB8LQAAgi0AAIotAACaLQAApi0AAMUtAADPLQAA2S0AAOstAAABLgAADC4AABYuAAAeLgAAMC4AADguAAA+LgAAVC4AAGQuAABtLgAAci4AAH8uAACTLgAAny4AAKkuAACzLgAAwS4AANEuAADjLgAA9i4AAAAvAAAJLwAAES8AABovAAApLwAANC8AAD0vAABPLwAAXy8AAGgvAAB4LwAAgy8AAI8vAAChLwAAsy8AAMAvAADJLwAA0C8AANkvAADjLwAA6y8AAPYvAAACMAAADjAAABkwAAAjMAAAKzAAADkwAAA/MAAASDAAAE0wAABUMAAAWjAAAGcwAABtMAAAczAAAIEwAACGMAAAmzAAAKIwAAC1MAAAvjAAAMYwAADVMAAA5DAAAPIwAAD9MAAABjEAAAwxAAATMQAAGjEAACExAAA3MQAAQjEAAE4xAABXMQAAXzEAAGwxAAB2MQAAgzEAAI4xAACTMQAApjEAALMxAADEMQAA0TEAANwxAADqMQAA8TEAAPoxAAD/MQAAljIAAA0zAABtMwAAoDMAAKMzAADvMwAA8jMAABwAAAAiAAAAJgAAACoAAAArAAAALAAAAC0AAAA3AAAAOAAAADkAAAA6AAAAOwAAADwAAAA9AAAAPgAAAD8AAABBAAAAQgAAAEMAAABEAAAARQAAAEYAAABHAAAASAAAAEkAAABKAAAASwAAAEwAAABNAAAATgAAAE8AAABQAAAAUQAAAFIAAABTAAAAVAAAAFUAAABWAAAAVwAAAFkAAABaAAAAWwAAAFwAAAB1AAAAgAAAAIQAAACFAAAAhgAAAB0AAAAAAAAARB8AACIAAAABAAAAAAAAACMAAAABAAAARB8AACQAAAABAAAATB8AACUAAAABAAAAVB8AACcAAAACAAAAVB8AADQAAAAFAAAAXB8AACgAAAAPAAAAAAAAADIAAAAPAAAAZB8AAC4AAAATAAAARB8AACgAAAAVAAAAAAAAADEAAAAVAAAAbB8AADUAAAAVAAAAdB8AADIAAAAVAAAAVB8AADQAAAAVAAAAhB8AADIAAAAVAAAAjB8AACgAAAAYAAAAAAAAAC4AAAAYAAAARB8AAC8AAAAYAAAATB8AADQAAAAYAAAAXB8AADIAAAAYAAAAZB8AADIAAAAYAAAAlB8AACkAAAAZAAAAnB8AAC4AAAAZAAAARB8AADAAAAAZAAAApB8AADIAAAAZAAAAZB8AADYAAAAZAAAArB8AACgAAAAcAAAAAAAAADIAAAAeAAAAtB8AADIAAAAfAAAAZB8AADQAAAAhAAAAvB8AACgAAAAjAAAAAAAAAHUAAAArAAAAAAAAAHYAAAArAAAARB8AAHgAAAArAAAApB8AAHoAAAArAAAAXB8AAHoAAAArAAAAxB8AAHkAAAArAAAAZB8AAHsAAAArAAAAzB8AAHkAAAArAAAAPB8AAHwAAAArAAAArB8AAH0AAAArAAAA2B8AAHkAAAArAAAA4B8AAIAAAAAsAAAAAAAAAIEAAAAsAAAA6B8AAIEAAAAsAAAAVB8AAIEAAAAsAAAAZB8AADMAAAAvAAAA8B8AAAMAFQABAQAAAwAPAAIBAAAEAC4AAAEAAAQAFQADAQAABAAhAAQBAAAFACwAqwAAAAUAAQC2AAAABgAYAGEAAAAGABgAbwAAAAYAAQB3AAAABgABAH8AAAATAA8AcAAAABoADQDnAAAAJQAlAGUAAAApACkAaQAAAAMAIwAYAAAAAwAKAKYAAAADABAApgAAAAQAJgAYAAAABAAKAKYAAAAFACkAGAAAAAUAEQD6AAAABgAgABgAAAAGAAYAiQAAAAYAEwClAAAABgARAKgAAAAGABQAswAAAAYADADWAAAABgAqAN4AAAAGAAYA6AAAAAYAFAAFAQAADQAlAOsAAAAPAAgAtwAAAA8AHAC/AAAADwAdAMAAAAAPAB4AwQAAAA8AHQDCAAAADwAeAMcAAAAPABAAyAAAAA8ALQDYAAAAEQAlABgAAAASACUAGAAAABMAAQDVAAAAEwAJAAcBAAAUAAMA4AAAABUAIAAYAAAAFQAHAL0AAAAXACUAGAAAABgAAACnAAAAGAAsAKwAAAAYAC4AsAAAABgALQCxAAAAGAAuALIAAAAYAAIA1AAAABgAAQDcAAAAGAAuAN8AAAAYAC8A9AAAABgAEgD3AAAAGAAVAPsAAAAZACAAGAAAABkAJQAYAAAAGQAWAKQAAAAZABcApAAAABkAGACkAAAAGQAZAKQAAAAZABoApAAAABkAEAD8AAAAGgAhALQAAAAbACQAGAAAABsAKADwAAAAGwAiAPMAAAAbACAA9QAAABwAGwC8AAAAHQAlABgAAAAeAA8A4wAAAB8ADQC4AAAAHwAtALsAAAAfAAQAxAAAAB8ABQDFAAAAHwAoAO4AAAAhAA4A1gAAACEAKADuAAAAIgAlABgAAAAiABAAwwAAACIAAQDLAAAAIgAQAMwAAAAiABAAzQAAACMAKwDSAAAAIwAKAOQAAAAkAB8A2wAAACQAAQDyAAAAKAAnABgAAAAoAAsAuAAAAAMAAAAAAAAAFQAAADwfAAAgAAAA5DUAAAA1AAAAAAAABAAAAAAAAAAVAAAAPB8AACAAAAAMNgAAGTUAAAAAAAAFAAAAEAAAABUAAAAAAAAAIAAAACw2AAAwNQAAAAAAAAYAAAARAAAAFQAAAAAAAAAgAAAAPDYAAEI1AAB2NQAAAgABAAEAAACeHQAABQAAAG4QAgABAAwAEQAAAAUAAQACAAAAoh0AACwAAAASEBJBNhAiAFRCAQBUQwAAcSAIADIADAJSIwYAPAMRAFUjBQA4Aw0AMxADACgJFgGWAHEgNwAhANgAAAEo424gBgACAAwAEQAiABIAGgFgAHAgGgAQACcAAwADAAEAAACuHQAACAAAAFsBAQBbAgAAcBAeAAAADgAEAAEAAwAAALQdAAALAAAAVDAEAFQxAwBUMgIAbjBBABACDAARAAAABAAEAAEAAAC5HQAACgAAAFsBBABbAgMAWwMCAHAQHgAAAA4ABAACAAIAAADBHQAAMgAAACIAGQBwECwAAAAaAQwBbiAxABAADABVIQUAbiAyABAADAAaAQwAbiAxABAADABSIQYAbiAvABAADAAaARUAbiAxABAADABuIC8AMAAMAxoADwFuIDEAAwAMA24QMwADAAwDEQMDAAMAAQAAAMYdAAAIAAAAcBAeAAAAXAEFAFkCBgAOAAIAAgACAAAAzx0AAAUAAABxIA4AEAAMABEAAAANAAIABQAAANUdAADpAAAAHAAYACQQLQAAAAwAGgGLACQQLgABAAwBGgLQAHFRDADLAgwLGgyOAHEQEQAMAAwMEgAjAS0AIwIuABoDuQBxUgwAvBMMCx8LJAA4C7wAGgyPAHEQEQAMAAwMGgGYAHEQEQABAAwBAAByEEoACwAMAgEDATRyEEgAAgAKBRMGEAA4BZQAchBJAAIADAXYBwMBNGMEACkAigAjAy0AIwYuABoI0QBxVgwAXDgMA24QHwADAAwFGgb9AG4gFQBlAAwFbiA8ADUADAU4BW0AIwYtACMILgAaCcoAcVgMAFFpDAYaCKkAbiAkAGgACgY5BgMAKFkjBi0AIwguABoJvgBxWAwAUWkMBRoGqgBuICQAVgAKBTkFAwAoRm4QHwADAAwFGgbaAG4gFQBlAAwFbiA9ADUACgVuEB8AAwAMBhoI1wBuIBUAhgAMBm4gPQA2AAoGbhAfAAMADAgaCa8AbiAVAJgADAhuID4AOAAKCG4QHwADAAwJGgrZAG4gFQCpAAwJbiA9ADkACgM4BQoAOAYIADkIBgA5AwQA2AQEAQFzKQBr/wFzKQBo/yIMBQByEEsACwAKCzZrAwASEHAwBQAMBBEMIgsSABoMXwBwIBoAywAnCwAABQAFAAMAAAD/HQAACQAAAG4wFgAgAwwAbjBBABAEDAARAAAABQACAAQAAQAIHgAAKwAAACIAKAAiAQMAcDAAADEEcCBMABAAIgMbABoEHgBwMDUAAwQSFG4gNgBDAG4QOAADAGIDDgAWAQIAbkBNABAyDAMfAxgAEQMNAxoDCwERAw0DGgMKAREDAAAYAAAACgABAAECKicQIwAAAgABAAAAAAAYHgAAGwAAADkBBQAaAWwAEQESIDMBBQAaAW0AEQESMDMBBQAaAWsAEQETAGYAMwEFABoBagARARoBcQARAQAABgABAAIAAAAhHgAAOQAAACIAGQBwECwAAAASAW4QJwAFAAoCNSEqAG4gIQAVAAoCEwNcADIyGAATBCIAM0IDACgSEwMgADQyCwATBH8AM0IDACgFbiAuACAAKAxuIC4AMAAoCG4gLgAwAAwDbiAuACMA2AEBASjTbhAzAAAADAURBQAABgABAAMAAAAvHgAA+AAAADgF8ABuECcABQAKADgA6gBuECcABQAKABMBAAg2EOIAEgABAW4QJwAFAAoCNSEdAG4gIQAVAAoCEwMgADcyDQATA38AMjIJABMDXAAyMgUA2AEBASjoIgURABoAcgBwIBkABQAnBRMBIwBuICYAFQAKASICIgA7AQQAB1EoBW4wKgAFAQwBcCBDABIAbhBEAAIADAEaA9MAbhBHAAIADARuICUAQwAKAzgDlABuEEYAAgAMAzkDjgA4AYwAbhAnAAEACgMTBP0ANkOEABoDFwBuICMAMQAKAzkDfABuEEUAAgAKAxL0MkMKAG4QRQACAAoCEwO7ATMybQBiAg0AbiArACEADAEaAogAbjApACEEDAEhEhIjNDJVACES2AIC/0YCAQIaA4MAbiAoADIACgI5AkgAIRI1IBcARgMBABoEhwBuICgAQwAKAzgDBQDYAAABKPIiBREAGgAhAHAgGQAFACcFAAAiABkAcBAsAAAAGgINAW4gMQAgAAwAIRPYAwP/RgEBA24gMQAQAAwAbiAxACAADABuEDMAAAAMABoBDgFuICIAAQAKADkAAwARBSIFEQAaAGYAcCAZAAUAJwUiBREAGgBkAHAgGQAFACcFIgURABoAYwBwIBkABQAnBSIFEQAaAHMAcCAZAAUAJwUBAAEAAQAAAFceAAAEAAAAcBAeAAAADgAbAAEABQASAFseAABPBQAACAEaABoC/wAaA7oAGgQNABoFBwAaBqkAIgcZABoICQFwIC0AhwAAAAAAEwgiABIpEgohGxIcNMuzBEYLAQoaDeYAbiAkANsACg0aDu0AEg84DRkAIR0znRYARgEBDHEQDwABAAwBKBgNAAcCB0MHUQGsKQCoBA0AB0MHUQGsKQDVBG4gJADrAAoNOA1/BCERM8F8BAfxGg0GAG4gMQDXAAwNbiAxAL0ADA1uIC4AjQA4ARMAGg0TAG4gMQDXAAwNcRALAAEADAxuIDEAzQAMDG4gLgCMABoMowBxEBEADAAMDBoN4QAjqC0AI6kuAHFZDAD8jQwIHwgTAG4QGwAIAAoIFAmghgEAlAwICRMNECc02DIENNwwBBQNuIIBADXcKwQaDJ8AcRARAAwADAwaDWgAbiAVANwADAxuID4A/AAKDBMNIwAz3A0EkwkICRoNEgBuIDEA1wAMDW4gLwCNAAwNGg8UAG4gMQD9AAwNbiAvAJ0ADA0aDxAAbiAxAP0ADA1uIC8AzQAaDKIAcRARAAwADAwaDcYAI68tAAgRBAAjpC4AEgpxVAwArP0MBDkEFQAaBOoAEgojrS0AI68uABIKcV8MAKzUKAgNAAcCB1EIAxEAKQD2AxoEkQBxEBEABAAMBBoK+AASDCPNLQAjzy4AEgxxXwwAxNoMChoMzwASDSPfLQAIEwUAI9UuAHFVDACk/AwFGgyZAHEQEQAMAAwMGg2uAAgUCwASLyP7LQAcDxgAExIAAE0PCxJiDwsAExABAE0PCxAIFQ4AEi8j/i4AEg9NBg4PcRAcAA8ADBITEAEATRIOEHFeDABcvQwFI/stACP9LgBxXQwAXLMMC24QHwALAAwNbiAVAC0ADA1uID4AvQAKCzOLQANuEB8ABQAMCxoN3QBuIBMA2wAMCxIdbiBAANsAbiA8AFsADAUaC5IAcRARAAsADAsaDa0AEi4j7y0AEg5NBA8OGgSVAHEQEQAEAAwEEh5NBA8ObjAUANsPDARuIEIA5AAkIC4AWgAMBRIKbjBBAKQFDAQaBckAEgojqy0AI60uAHFdDABMtQwFHwUYABoKygASCyO9LQAjvi4AcV4MAEzaDAofChgAI70tACO+LgBxXgwATNMMA24gJABWAAoFOAXTAm4gJACmAAoFOAXNAm4QHwADAAwFbiAVACUADAJuID4AMgAKAjOCvwIaAgkAbiAxACcAGgKaAHEQEQACAAwCGgONADgBYgAaBZ4AcRARAAUADAUSGCOKLQAcCBgAEgtNCAoLbiASAKIADAgSGiOrLgAaCpwAEg1NCgsNbiA7ALgADAgaCvEAJBAtAAUADAsSHSPeLgAaD+kACBoEACPULQAcDRgAExIAAE0NBBIkEC4AAQAMARINcVEMANVPDAESBE0BDgRxXgwAgroSESMULQBiBQsAEgpNBQQKIxUuABUBABhxEBwAAQAMAU0BBQpxVQwAgkMoZw0ABwIIAxEACAETACkAsAIIGgQAEhEjFC0AHAEYABIFTQEEBW4gEgBCAAwBEhQjRS4AGgSbABIITQQFCG4gOwBRAAwIGgGMABIUI0UtABwKGAASC00KBQsjSi4AGgSdAE0ECgtxWgwAglEaAe8AEiQjRS0AHAQYABIKTQQFChwEGAASGk0EBQoSJCNKLgASBE0GCgQaBKoAEhtNBAoLcVoMAIJRI7EtAGIECwASBU0EAQUjtC4AFQoAEHEQHAAKAAwKTQoEBXFUDACCExoBkABxEBEAAQAMARoDzgASBCNFLQAjSi4AEgRxWgwAQVMMARoDkwBxEBEAAwAMA24gGAATAAoEOATIARoE9gATBQwAI1otABoLlABxEBEACwAMCxINTQsKDRwLGAASHU0LCg0cCxgAEi1NCwoNEjtNAgoLHAIYABJNTQIKDRoCoQBxEBEAAgAMAhJeTQIKDhwCGAASb00CCg9iAgsAExYHAE0CChZiAgsAExcIAE0CChcaApYAcRARAAIADAITGAkATQIKGBoCoABxEBEAAgAMAhMZCgBNAgoZYgILABMZCwBNAgoZbjAWAEMKDAIjUy4AEgQSBU0EAwUSFU0GAwUSJU0EAwVNCAMLTQQDDU0EAw5NBAMPEvRxEBwABAAMBE0EAxYSBHEQHAAEAAwFTQUDFxIETQQDGBMFCgBNBAMFcRAcAAkADAUTBgsATQUDBiIFKAAiBgQAcEADACYxcCBMAGUAIgEbABoCHwBwMDUAUQISEm4gNgAhAAAAbhA4AAEAYgEOABYCCgBuQE0AJRMMARoClwBxEBEAAgAMAjgB8QBuIBgAEgAKAzgD6wAaA+wAbiAVADIADANuID4AEwAKAxoF+QBuIBUAUgAMBW4gPQAVAAoFGgYIAW4gFQBiAAwGbiA8ABYADAY5BgQAB08oFRoEmABxEBEABAAMBBoItQASCSOaLQAjnS4AcV0MAGSoDAQHTx8PGAAaBBYAbiAxAEcADARuIC8ANAAMBBoGCgBuIDEAZAAMBHEQCgADAAwGbiAxAGQADAQaBgAAbiAxAGQADARuIDIAVAAMBBoGDgBuIDEAZAA5DxkAGgTlAG4gMQBHACg0DQAHAggDEQAIARMAEhwpAA4BDQAIAxEACAETABIcKQA5ARMEIgBuIC4ARwAMBm4QJwAPAAoEEwi0AHEgHQCEAAoEEghuMCoAjwQMBHEQCwAEAAwEbiAxAEYADAQTBiIAbiAuAGQAGgQPAG4gMQBHAAwEGgb+AG4gFQBiAAwCbiA/ABIACwFuMDAAFAIIARQACAIVAG4gJAAhAAoBOAEaADkFGAA4AwcAEiEyEwQAM7MRABoBEQBuIDEAFwAMAQgCGgBxIAkALAAMAm4gMQAhAAgBEwBuIDEAFwAMARISbiAyACEADAEIAxEAbiAxADEAYgEMAG4QMwAHAAwCbiAQACEAEgEpAOEACAMRAAgBEwASEiIEEgAaBV0AcCAaAFQAJwQNACgJDQAoEQ0ACAMRAAgBEwASEgEsBwIpAHgADQAIAxEACAETABISASwpAKIACAMRAAgBEwAiAhcAGgQbAHAgIABCACcCCAMRAAgBEwAiAhcAGgRuAHAgIABCACcCCAMRAAgBEwAiAhcAGgRiAHAgIABCACcCDQAIAxEACAETAChCDQAIAxEACAETACkAcAANAAdRCAMRACg2DQAHUQgDEQApAGUAB0MHUSICHQAaBGcAcCA6AEIAJwIHQwdRIgIXABoEXgBwICAAQgAnAgdDB1EiAhEAGgR0AHAgGQBCACcCB0MHUSICEQAaBBoAcCAZAEIAJwINACgGDQAoOA0AB0MHUQcCEgwgJCAAOQQGACAkJwA4BA0AbhA5AAIADAQ4BAcAbhA5AAIADAIo7hoECwBuIDEARwAMBG4QHwACAAwCbhAXAAIADAJxEAsAAgAMAm4gMQAkAAwCEwQiAG4gLgBCACgLDQAHQwdREgwaAggAbiAxACcAAABuIDEAFwAMAW4gMgDBAAwBbiAxADEAYgEMAG4QMwAHAAwCbiAQACEAEiFxEDQAAQAAAA4ADQAHAm4gMQAXAAwBbiAyAMEADAFuIDEAMQBiAQwAbhAzAAcADANuIBAAMQASAXEQNAABACcCAAAZAAAADAABACoAAAAJAAcAQQAAABcAAQBaAAAAEQAHAGsAAABjAAEA0AAAAAcACwDZAAAACwARAOwAAAAXAAsABQEAAMkAFwDSAQAAVwAdADUCAAAYARcATgMAAHYAIwDGAwAABQApAN8DAAA7ACMAJQQAAA8AKQBVBAAACAAvAHgEAABgADUA4QQAADgAOwALfyqQCtwJfyo7NH8qqgmlCX8qqgnlAX8qngmYCX8qngmqBH8q6wjhCH8q1QfMB38q3wjdCH8q2gnYCQC0CmkADgBrAA5Lh7YCe1k9XgBpAgAADgDEAQAOAMMBAwAAAA4ASQEADgBEAgAADjwtLQAMAgAADgBPAgAADgESDwETDy1paR4BEg9ppeMBFQ8BEw/h4eHjpQJxOwIQOwJs0QAfBQAAAAAADgBpAgAADgIMpHhLPbYeOB4AOgEADlppaXgAEwEADlp4S5aWSUl1QQAjAQAO/4dLwD2IadJLARQP//BpaQERD1qFPIgeASQPHAJ7hoMCdoYADAAOAIIBAQAOARMPHh+HLgLUAAEVDnQCsH9optIBExBp/1q0/0stAR0PaQLFAAEbDgK8f3dpw9JpAScPh+GlS0sBGw88ltLShwEaD1tqS2kBGA8BJA8BFRECKB0CWYYBGg8BEw8BHQ8BFBABEg9paYcBGw8BGg8BGAtOATEPp3hLHjyHaYelpaUBGA/DARgPPI+SAnuGASIPARMPARMP+f+WAmg7AhHRKS+hAmOVAmzCAnbCAj7CZXpWArp/aKICeKQtAnuGAtcApCkvWgETDwEbDwJ6HUtaI7SWSx4Z0pZLAAAAAAEAAAAmAAAAAQAAAAEAAAACAAAAAQABAAEAAAAVAAAAAgAAAA8AFQABAAAAGAAAAAIAAAACACkABQAAAA8AFQAYAC0ALgAAAAIAAAAVAC4AAQAAAC4AAAABAAAAJQAAAAEAAAAAAAAAAQAAAAIAAAABAAAALAAAAAEAAAAtAAAAAgAAABgALQACAAAAFgAYAAMAAAAhABUALgAAAAIAAAAsAAEAAQAAAC8AAAABAAAADgAAAAIAAAAYAAEAEyIsIndhaXRfdGltZWRfb3V0IjoAASgAAygpVgABKQADKj47AAQqPjtbAAssImFjdGlvbiI6IgAcLCJhY3Rpdml0eV9yZXF1ZXN0X2VudGVyZWQiOgA6LCJiaW5kZXJfY2FsbF90aW1lZF9vdXQiOnRydWUsIndhaXRfcmVzdWx0X3JlY2VpdmVkIjpmYWxzZQB4LCJjYWxsaW5nX3BhY2thZ2UiOiJjb20udGVybXV4IiwicGFja2FnZV9hdHRyaWJ1dGlvbl92ZXJpZmllZCI6dHJ1ZSwiY2FsbGVyX3RocmVhZF9pc19udWxsIjp0cnVlLCJvcHRpb25zX2FyZV9udWxsIjp0cnVlABMsImNsYXNzaWZpY2F0aW9uIjoiABAsImVycm9yX2NsYXNzIjoiACUsImZvY3VzZWRfdmlzaWJsZV90ZXJtdXhfdGFza19jb3VudCI6AC8sIm1heGltdW1fYWN0aXZpdHlfcmVxdWVzdHMiOjEsIm5vX3JldHJ5Ijp0cnVlfQAWLCJyZXBvcnRlZF9jb21wb25lbnQiOgAaLCJyZXBvcnRlZF90b3RhbF90aW1lX21zIjoABywic2RrIjoAFSwidGVybXV4X3Zpc2liaWxpdHkiOgAHLCJ1aWQiOgAILCJ1cmwiOiIACywidXNlcl9pZCI6ABYsInZpc2liaWxpdHlfc2FtcGxlcyI6ADAsIndhaXRfcmVzdWx0X3JlY2VpdmVkIjp0cnVlLCJyYXdfc3RhcnRfcmVzdWx0IjoAAS4ABjxpbml0PgACPjsAD0FjdGlvbiByZXF1aXJlZAArQWN0aXZpdHkgdGFzayBtYW5hZ2VyIGludGVyZmFjZSB1bmF2YWlsYWJsZQABQwACQ0kAF0N1cnRPd25UZXJtdXhWaXNpYmlsaXR5ABRDdXJ0U2FtZVVpZFN0YXJ0V2FpdAAaQ3VydFN0YXJ0QWN0aXZpdHlXYWl0LmphdmEADkhvc3RuYW1lIGxhYmVsAAFJAAJJSQADSUlJAAJJTAABSgACSkwAAUwAAkxDABlMQ3VydFN0YXJ0QWN0aXZpdHlXYWl0JDE7ABlMQ3VydFN0YXJ0QWN0aXZpdHlXYWl0JDI7ACpMQ3VydFN0YXJ0QWN0aXZpdHlXYWl0JFZpc2liaWxpdHlTbmFwc2hvdDsAF0xDdXJ0U3RhcnRBY3Rpdml0eVdhaXQ7AAJMSQADTElJAAJMSgADTEpMAAJMTAADTExJAANMTEwABkxMTExMTAACTFoAIkxkYWx2aWsvYW5ub3RhdGlvbi9FbmNsb3NpbmdDbGFzczsAI0xkYWx2aWsvYW5ub3RhdGlvbi9FbmNsb3NpbmdNZXRob2Q7AB5MZGFsdmlrL2Fubm90YXRpb24vSW5uZXJDbGFzczsAIUxkYWx2aWsvYW5ub3RhdGlvbi9NZW1iZXJDbGFzc2VzOwAdTGRhbHZpay9hbm5vdGF0aW9uL1NpZ25hdHVyZTsAGkxkYWx2aWsvYW5ub3RhdGlvbi9UaHJvd3M7ABVMamF2YS9pby9QcmludFN0cmVhbTsAGExqYXZhL2xhbmcvQ2hhclNlcXVlbmNlOwARTGphdmEvbGFuZy9DbGFzczsAEUxqYXZhL2xhbmcvQ2xhc3M8ABVMamF2YS9sYW5nL0V4Y2VwdGlvbjsAJExqYXZhL2xhbmcvSWxsZWdhbEFyZ3VtZW50RXhjZXB0aW9uOwAhTGphdmEvbGFuZy9JbGxlZ2FsU3RhdGVFeGNlcHRpb247ABNMamF2YS9sYW5nL0ludGVnZXI7ABBMamF2YS9sYW5nL01hdGg7ABJMamF2YS9sYW5nL09iamVjdDsAFExqYXZhL2xhbmcvUnVubmFibGU7AB1MamF2YS9sYW5nL1NlY3VyaXR5RXhjZXB0aW9uOwASTGphdmEvbGFuZy9TdHJpbmc7ABlMamF2YS9sYW5nL1N0cmluZ0J1aWxkZXI7ABJMamF2YS9sYW5nL1N5c3RlbTsAEkxqYXZhL2xhbmcvVGhyZWFkOwAVTGphdmEvbGFuZy9UaHJvd2FibGU7AClMamF2YS9sYW5nL1Vuc3VwcG9ydGVkT3BlcmF0aW9uRXhjZXB0aW9uOwAfTGphdmEvbGFuZy9yZWZsZWN0L0NvbnN0cnVjdG9yOwAZTGphdmEvbGFuZy9yZWZsZWN0L0ZpZWxkOwAtTGphdmEvbGFuZy9yZWZsZWN0L0ludm9jYXRpb25UYXJnZXRFeGNlcHRpb247ABpMamF2YS9sYW5nL3JlZmxlY3QvTWV0aG9kOwAOTGphdmEvbmV0L1VSSTsAFExqYXZhL3V0aWwvSXRlcmF0b3I7ABBMamF2YS91dGlsL0xpc3Q7ABJMamF2YS91dGlsL0xvY2FsZTsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9DYWxsYWJsZTsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9DYWxsYWJsZTwAKUxqYXZhL3V0aWwvY29uY3VycmVudC9FeGVjdXRpb25FeGNlcHRpb247ACFMamF2YS91dGlsL2NvbmN1cnJlbnQvRnV0dXJlVGFzazsAH0xqYXZhL3V0aWwvY29uY3VycmVudC9UaW1lVW5pdDsAJ0xqYXZhL3V0aWwvY29uY3VycmVudC9UaW1lb3V0RXhjZXB0aW9uOwAVTm8gQW5kcm9pZCBXYWl0UmVzdWx0ACNPcmRpbmFyeSBpbnN0YWxsZWQgYXBwIFVJRCByZXF1aXJlZAAaT3duIHRhc2sgcXVlcnkgdW5hdmFpbGFibGUAKU93biB2aXNpYmlsaXR5IG9ic2VydmF0aW9uIGRpZCBub3QgZmluaXNoAAdQQUNLQUdFAC5QYWNrYWdlIG11c3QgYmVsb25nIHRvIHRoZSBhY3R1YWwgaW52b2tpbmcgVUlEABlQdWJsaWMgSFRUUFMgVVJMIHJlcXVpcmVkABhQdWJsaWMgaG9zdG5hbWUgcmVxdWlyZWQABFJPT1QAEVJlc2VydmVkIGhvc3RuYW1lAClSZXZpZXdlZCBBbmRyb2lkIEFQSTM1IHNpZ25hdHVyZSByZXF1aXJlZAAHU0RLX0lOVAAHU0VDT05EUwANU1RBUlRfQUJPUlRFRAAWU1RBUlRfREVMSVZFUkVEX1RPX1RPUAANU1RBUlRfU1VDQ0VTUwATU1RBUlRfVEFTS19UT19GUk9OVAAkU2FtZSBVSUQgVGVybXV4IGF0dHJpYnV0aW9uIHJlcXVpcmVkAA9URVJNVVhfQUNUSVZJVFkABFRZUEUAE1VOUkVDT0dOSVpFRF9SRVNVTFQADlVSTCBjaGFyYWN0ZXJzAApVUkwgbGVuZ3RoABhVbnN1cHBvcnRlZCBmaXhlZCBhY3Rpb24AAVYAAlZJABdWSVNJQklMSVRZX1dBSVRfU0VDT05EUwACVkoAAlZMAANWTEwABFZMTEwAAlZaAANWWkkAElZpc2liaWxpdHlTbmFwc2hvdAAMV0FJVF9TRUNPTkRTAAFaAAJaTAABWwAGWzAtOV0rABJbTGphdmEvbGFuZy9DbGFzczsAE1tMamF2YS9sYW5nL09iamVjdDsAE1tMamF2YS9sYW5nL1N0cmluZzsAJFthLXowLTldKD86W2EtejAtOS1dezAsNjF9W2EtejAtOV0pPwACXC4ACmFjY2VzcyQwMDAAC2FjY2Vzc0ZsYWdzAAhhY3Rpdml0eQALYWRkQ2F0ZWdvcnkACGFkZEZsYWdzABthbmRyb2lkLmFwcC5BY3Rpdml0eU1hbmFnZXIAI2FuZHJvaWQuYXBwLkFjdGl2aXR5TWFuYWdlciRBcHBUYXNrAB9hbmRyb2lkLmFwcC5BY3Rpdml0eVRhc2tNYW5hZ2VyABphbmRyb2lkLmFwcC5BY3Rpdml0eVRocmVhZAAXYW5kcm9pZC5hcHAuQ29udGV4dEltcGwAIGFuZHJvaWQuYXBwLklBY3Rpdml0eVRhc2tNYW5hZ2VyAB5hbmRyb2lkLmFwcC5JQXBwbGljYXRpb25UaHJlYWQAFWFuZHJvaWQuYXBwLkxvYWRlZEFwawAYYW5kcm9pZC5hcHAuUHJvZmlsZXJJbmZvABZhbmRyb2lkLmFwcC5XYWl0UmVzdWx0AB1hbmRyb2lkLmNvbnRlbnQuQ29tcG9uZW50TmFtZQAXYW5kcm9pZC5jb250ZW50LkNvbnRleHQAFmFuZHJvaWQuY29udGVudC5JbnRlbnQAGmFuZHJvaWQuaW50ZW50LmFjdGlvbi5NQUlOABphbmRyb2lkLmludGVudC5hY3Rpb24uVklFVwAgYW5kcm9pZC5pbnRlbnQuY2F0ZWdvcnkuTEFVTkNIRVIAD2FuZHJvaWQubmV0LlVyaQAYYW5kcm9pZC5vcy5CdWlsZCRWRVJTSU9OABFhbmRyb2lkLm9zLkJ1bmRsZQASYW5kcm9pZC5vcy5JQmluZGVyABFhbmRyb2lkLm9zLkxvb3BlcgASYW5kcm9pZC5vcy5Qcm9jZXNzAAZhcHBlbmQAF2JvdW5kZWRUZXJtdXhWaXNpYmlsaXR5AARjYWxsAAZjaGFyQXQADmNsYXNzaWZpY2F0aW9uAApjb20udGVybXV4AB1jb20udGVybXV4LmFwcC5UZXJtdXhBY3Rpdml0eQAIY29tcGxldGUACGNvbnRhaW5zABBjcmVhdGVBcHBDb250ZXh0ABRjcmVhdGVQYWNrYWdlQ29udGV4dAAJZGlzcGxheUlkAAhlbmRzV2l0aAAGZXF1YWxzABBlcXVhbHNJZ25vcmVDYXNlAAZlc2NhcGUABGV4aXQAFGZsYXR0ZW5Ub1Nob3J0U3RyaW5nAA5mb2N1c2VkVmlzaWJsZQAHZm9yTmFtZQADZ2V0AAtnZXRBcHBUYXNrcwASZ2V0QXBwbGljYXRpb25JbmZvAApnZXRCb29sZWFuAAhnZXRDYXVzZQAIZ2V0Q2xhc3MADGdldENsYXNzTmFtZQAOZ2V0Q29uc3RydWN0b3IAEGdldERlY2xhcmVkRmllbGQAEWdldERlY2xhcmVkTWV0aG9kAAhnZXRGaWVsZAAHZ2V0SG9zdAAGZ2V0SW50AAdnZXRMb25nAA1nZXRNYWluTG9vcGVyAAlnZXRNZXRob2QAB2dldE5hbWUAEGdldE9wUGFja2FnZU5hbWUADmdldFBhY2thZ2VOYW1lAAdnZXRQb3J0AA5nZXRSYXdVc2VySW5mbwAJZ2V0U2NoZW1lAApnZXRTZXJ2aWNlABBnZXRTeXN0ZW1Db250ZXh0ABBnZXRTeXN0ZW1TZXJ2aWNlAAtnZXRUYXNrSW5mbwAHaGFzTmV4dAAFaHR0cHMAB2luZGV4T2YACGludFZhbHVlAAZpbnZva2UACWlzRm9jdXNlZAAKaXNJbnN0YW5jZQAKaXNTbGVlcGluZwAJaXNWaXNpYmxlAAhpdGVyYXRvcgAGbGVuZ3RoAAxtUGFja2FnZUluZm8ABG1haW4AB21hdGNoZXMAA21pbgAFbXlVaWQABG5hbWUAC25ld0luc3RhbmNlAARuZXh0AARudWxsAAxvcGVuLXdlYnNpdGUAA291dAATb3duVGVybXV4VmlzaWJpbGl0eQAFcGFyc2UAEXByZXBhcmVNYWluTG9vcGVyAAdwcmludGxuAAZyZXN1bHQADXJldHVybi10ZXJtdXgADXNldEFjY2Vzc2libGUADHNldENsYXNzTmFtZQAJc2V0RGFlbW9uAAdzZXREYXRhAARzaXplAAVzbGVlcAAFc3BsaXQABXN0YXJ0ABRzdGFydEFjdGl2aXR5QW5kV2FpdAAJc3Vic3RyaW5nAApzeXN0ZW1NYWluAAd0aW1lb3V0AAZ0b0pzb24AC3RvTG93ZXJDYXNlAAh0b1N0cmluZwALdG9wQWN0aXZpdHkACXRvdGFsVGltZQADdWlkABF2YWwkY2FsbEFyZ3VtZW50cwALdmFsJGNvbnRleHQAD3ZhbCRjb250ZXh0VHlwZQALdmFsJHNlcnZpY2UACXZhbCRzdGFydAAMdmFsaWRhdGVkVXJsAAV2YWx1ZQAHdmFsdWVPZgADd2hvAJQBeyJraW5kIjoiY2x1c3Rlci1hbmRyb2lkLXN0YXJ0LXJlc3VsdCIsInBlcm1pc3Npb25zX2NoYW5nZWQiOmZhbHNlLCJzZXR0aW5nc19jaGFuZ2VkIjpmYWxzZSwiaWRlbnRpdHlfY2hhbmdlZCI6ZmFsc2UsInZpc2libGVfc2NyZWVuX3ZlcmlmaWVkIjpmYWxzZQB1eyJxdWVyeV9zdWNjZWVkZWQiOmZhbHNlLCJ0YXNrX3NuYXBzaG90X2NvbXBsZXRlIjpmYWxzZSwiZm9jdXNlZF92aXNpYmxlX3Rlcm11eF90YXNrX2NvdW50IjowLCJxdWVyeV90aW1lZF9vdXQiOnRydWV9AF57InF1ZXJ5X3N1Y2NlZWRlZCI6ZmFsc2UsInRhc2tfc25hcHNob3RfY29tcGxldGUiOmZhbHNlLCJmb2N1c2VkX3Zpc2libGVfdGVybXV4X3Rhc2tfY291bnQiOjB9ADF7InF1ZXJ5X3N1Y2NlZWRlZCI6dHJ1ZSwidGFza19zbmFwc2hvdF9jb21wbGV0ZSI6AAF8AEp8bG9jYWxob3N0fGxvY2FsfGxvY2FsZG9tYWlufGhvbWV8bGFufGludGVybmFsfHRlc3R8aW52YWxpZHxvbmlvbnxleGFtcGxlfAABfQBmfn5EOHsiYmFja2VuZCI6ImRleCIsImNvbXBpbGF0aW9uLW1vZGUiOiJkZWJ1ZyIsImhhcy1jaGVja3N1bXMiOmZhbHNlLCJtaW4tYXBpIjozNSwidmVyc2lvbiI6IjguMy4zNyJ9AAILAYYCHAEXAgIMAYYCHAEYEAIIAYYCGgkCCQKKAQQA4gEeAgsBhgIcBBdGF1gXSRcZAggBhgIaDQILAYYCHAQXRhdYF0YXGQIHAYYCGAYCCQKKAQQa4gEXfgILAYYCHAsXARdAFwQXRhdJF4IXQBcFF0YXAxdGAgsBhgIcBhcBF0AXBBdGFwMXLAILAYYCHAYXARdAFwQXRhcDF0kCCgGGAhwBGAUAAgECAJAgAZAgAICABKAXAcEgnBYBAbgWAAMBAQKQIAGQIAGQIAOAgAToFwQBwBcAAgEBBRABEAWAgASAGQYAjBgEAAkABxoBGgEaARoHgYAEiCQBiCCgGQEKxB0BCrweAQqEHwGKAaAdAQmgJAEKvBkBCoggBBepF6oEAgQKAAEAAABaNAAAAQAAAGM0AAADAAAAbDQAAHM0AAB9NAAAAwAAAIw0AABzNAAAkzQAAAIAAACiNAAAqTQAAAIAAAC0NAAAYzQAAAIAAADRNAAAYzQAAAEAAADkNAAAAQAAAPc0AACQNQAAAAAAAAMAAAAAAAAAAAAAAIA1AAABAAAAiDUAAAIAAACINQAAoDUAAAAAAAACAAAAAAAAAAMAAACANQAABAAAAIg1AACwNQAAAAAAAAAAAAAAAAAA3DUAAAAAAAAFAAAAAAAAAAgAAACINQAACQAAANQ1AAAMAAAAvDUAAA4AAADINQAADwAAAIg1AAARAAAAAAAAAAEAAAAAAAAAAQAAABEBAABwAAAAAgAAADAAAAC0BAAAAwAAADAAAAB0BQAABAAAAA8AAAC0BwAABQAAAE4AAAAsCAAABgAAAAQAAACcCgAAASAAABAAAAAcCwAAAyAAABAAAACeHQAAARAAABYAAAA8HwAAAiAAABEBAAD4HwAABCAAAA0AAABaNAAAACAAAAQAAAAANQAABSAAAAEAAAB2NQAAAxAAAAkAAACANQAABiAAAAQAAADkNQAAABAAAAEAAAB0NgAA'
# END PINNED ANDROID DEX
DESKTOP_KEYS = frozenset({
    "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
    "XAUTHORITY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "DESKTOP_SESSION",
})
DESKTOP_PROCESSES = frozenset({
    "gnome-shell", "gnome-session", "gnome-session-binary", "plasmashell", "ksmserver",
    "kwin_wayland", "kwin_x11", "sway", "weston", "Hyprland", "Xwayland",
    "cinnamon", "xfce4-session", "lxqt-session", "mate-session", "gamescope", "steam",
})


class LaunchError(ValueError):
    pass


def compact_text(value, limit=500):
    text = " ".join(str(value).split())[:limit]
    while len(json.dumps(text, ensure_ascii=True)) - 2 > limit:
        text = text[:-1]
    return text


def validate_url(url):
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise LaunchError("Use one HTTPS URL of at most 2048 characters.")
    if any(ord(char) <= 32 or ord(char) == 127 for char in url) or "\\" in url:
        raise LaunchError("URL contains unsafe whitespace or characters.")
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() != "https" or not parsed.netloc:
            raise LaunchError("Only HTTPS browser navigation is supported.")
        if parsed.username is not None or parsed.password is not None:
            raise LaunchError("Credentials in URLs are excluded.")
        if parsed.port not in (None, 443):
            raise LaunchError("Only the default HTTPS port is supported.")
        host = parsed.hostname
        if not host or host.endswith("."):
            raise LaunchError("A valid public hostname is required.")
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            host = host.encode("idna").decode("ascii").lower()
            labels = host.split(".")
            if len(host) > 253 or len(labels) < 2 or labels[-1].isdigit() or any(
                not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                for label in labels
            ):
                raise LaunchError("A valid public hostname is required.")
            if labels[-1] in {"localhost", "local", "localdomain", "home", "lan", "internal", "test", "invalid", "onion", "example"}:
                raise LaunchError("Local and reserved hostnames are excluded.")
        else:
            raise LaunchError("Use a public hostname; IP addresses are excluded.")
    except (ValueError, UnicodeError) as exc:
        if isinstance(exc, LaunchError):
            raise
        raise LaunchError("Invalid HTTPS URL.") from exc
    authority = "[" + host + "]" if ":" in host else host
    normalized = urlunsplit(("https", authority,
                            quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~"), "", ""))
    if "?" in url.split("#", 1)[0]:
        normalized += "?" + quote(parsed.query, safe="/%?:@!$&'()*+,;=-._~")
    if "#" in url:
        normalized += "#" + quote(parsed.fragment, safe="/%?:@!$&'()*+,;=-._~#")
    if len(normalized) > MAX_URL_LENGTH:
        raise LaunchError("Encoded URL exceeds 2048 characters.")
    return normalized


def platform_name(environ, current_platform=None):
    prefix = environ.get("PREFIX", "")
    if environ.get("TERMUX_VERSION") or (prefix.startswith("/data/") and prefix.endswith("/com.termux/files/usr")):
        return "android"
    current_platform = sys.platform if current_platform is None else current_platform
    return "linux" if current_platform.startswith("linux") else current_platform


def desktop_values(environ):
    return {
        key: value for key, value in environ.items()
        if key in DESKTOP_KEYS and isinstance(value, str) and 0 < len(value) <= 1024
        and not any(ord(char) < 32 or ord(char) == 127 for char in value)
    }


def own_desktop_environments(uid, proc_root="/proc"):
    """Read only selected environment keys from this UID's desktop processes."""
    root = pathlib.Path(proc_root)
    try:
        entries = sorted((entry for entry in root.iterdir() if entry.name.isdigit()), key=lambda entry: int(entry.name))[:2048]
    except OSError:
        return
    for entry in entries:
        try:
            if entry.stat().st_uid != uid:
                continue
            with (entry / "comm").open("rb") as stream:
                name = stream.read(64).decode("ascii", errors="replace").strip()
            if name not in DESKTOP_PROCESSES:
                continue
            with (entry / "environ").open("rb") as stream:
                raw = stream.read(65536)
            selected = {}
            for item in raw.split(b"\0"):
                key, separator, value = item.partition(b"=")
                if separator and key.decode("ascii", errors="replace") in DESKTOP_KEYS:
                    selected[key.decode("ascii")] = value.decode("utf-8", errors="replace")
            yield desktop_values(selected)
        except (OSError, UnicodeError):
            continue


def valid_graphical_environment(values, uid):
    runtime = values.get("XDG_RUNTIME_DIR")
    runtime_valid = False
    if runtime and posixpath.isabs(runtime):
        try:
            info = os.stat(runtime)
            runtime_valid = stat.S_ISDIR(info.st_mode) and info.st_uid == uid
        except OSError:
            pass
    wayland = values.get("WAYLAND_DISPLAY")
    if runtime_valid and wayland and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", wayland) and wayland not in {".", ".."}:
        try:
            info = os.stat(posixpath.join(runtime, wayland))
            if stat.S_ISSOCK(info.st_mode) and info.st_uid == uid:
                return True
        except OSError:
            pass
    display = values.get("DISPLAY", "")
    match = re.fullmatch(r":(\d{1,4})(?:\.\d{1,2})?", display)
    if match:
        try:
            if stat.S_ISSOCK(os.stat("/tmp/.X11-unix/X" + match.group(1)).st_mode):
                return True
        except OSError:
            pass
    return False


def find_graphical_environment(environ, uid, proc_reader=None, checker=None):
    checker = valid_graphical_environment if checker is None else checker
    current = desktop_values(environ)
    if checker(current, uid):
        return current
    reader = own_desktop_environments if proc_reader is None else proc_reader
    for values in reader(uid):
        values = desktop_values(values)
        if checker(values, uid):
            return values
    raise LaunchError("No verified graphical desktop session for this user. Browser launch is unavailable.")


def android_native_cache(environ, uid):
    """Stage only pinned public code in an owned private cache; never an APK."""
    home = pathlib.Path(environ.get("HOME", ""))
    if not home.is_absolute():
        raise LaunchError("An existing owned Termux home directory is required.")
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise LaunchError("Termux home metadata could not be verified.")
    data = base64.b64decode(ANDROID_NATIVE_DEX_B64, validate=True)
    if not 0 < len(data) <= 65536 or hashlib.sha256(data).hexdigest() != ANDROID_NATIVE_SHA256:
        raise LaunchError("Pinned Android launcher code did not verify.")
    descriptor = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
    cache = home
    try:
        if (os.fstat(descriptor).st_dev, os.fstat(descriptor).st_ino) != (info.st_dev, info.st_ino):
            raise LaunchError("Termux home changed before code staging.")
        for name in ("cluster", "control", "browser-start-" + ANDROID_NATIVE_SHA256[:16]):
            try:
                os.mkdir(name, mode=0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            final = name.startswith("browser-start-")
            if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != uid
                    or info.st_mode & 0o022 or final and stat.S_IMODE(info.st_mode) != 0o700):
                raise LaunchError("Owned Android code cache metadata did not verify.")
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=descriptor)
            try:
                if (os.fstat(child).st_dev, os.fstat(child).st_ino) != (info.st_dev, info.st_ino):
                    raise LaunchError("Android code cache changed before staging.")
            except BaseException:
                os.close(child)
                raise
            os.close(descriptor)
            descriptor = child
            cache /= name
        filename = "launcher.dex"
        try:
            output = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW, 0o400, dir_fd=descriptor)
        except FileExistsError:
            pass
        else:
            with os.fdopen(output, "wb") as stream:
                stream.write(data)
        info = os.stat(filename, dir_fd=descriptor, follow_symlinks=False)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != uid or stat.S_IMODE(info.st_mode) != 0o400
                or info.st_nlink != 1 or info.st_size != len(data)):
            raise LaunchError("Pinned Android code file metadata did not verify.")
        source = os.open(filename, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(source, "rb") as stream:
            opened = os.fstat(stream.fileno())
            if (opened.st_dev, opened.st_ino, opened.st_size) != (info.st_dev, info.st_ino, info.st_size):
                raise LaunchError("Pinned Android code file changed before verification.")
            if hashlib.sha256(stream.read(len(data) + 1)).hexdigest() != ANDROID_NATIVE_SHA256:
                raise LaunchError("Pinned Android code digest did not verify.")
        return str(cache / filename)
    finally:
        os.close(descriptor)


def android_request(report, action, environ, run, uid=None, native_prepare=None):
    """One native request, no legacy am fallback; platform acceptance is not visibility."""
    prefix = environ.get("PREFIX", "")
    if not (prefix.startswith("/data/") and prefix.endswith("/com.termux/files/usr")):
        raise LaunchError("The existing ordinary Termux app environment is required.")
    uid = getattr(os, "getuid", lambda: -1)() if uid is None else uid
    if not isinstance(uid, int) or isinstance(uid, bool) or uid < 10000 or not 10000 <= uid % 100000 < 99000:
        raise LaunchError("An existing ordinary Termux app UID is required.")
    prepare = android_native_cache if native_prepare is None else native_prepare
    path = prepare(environ, uid)
    command_env = dict(environ)
    command_env.pop("LD_PRELOAD", None)
    command_env.pop("LD_LIBRARY_PATH", None)
    command_env["CLASSPATH"] = path
    command = ["/system/bin/app_process", "/", "CurtStartActivityWait", action]
    if action == "open-website":
        command.append(report["url"])
    report["launcher"] = command[0]
    completed = run(command, env=command_env, stdin=subprocess.DEVNULL,
                    capture_output=True, text=True, timeout=ANDROID_NATIVE_TIMEOUT_SECONDS,
                    check=False, shell=False)
    report["opener_completed" if action == "open-website" else "request_completed"] = True
    if not isinstance(completed.stdout, str) or len(completed.stdout) > 16384:
        raise LaunchError("Android returned an invalid launch receipt; the request is unconfirmed and will not be retried.")
    try:
        native = json.loads(completed.stdout)
    except (ValueError, TypeError):
        raise LaunchError("Android returned no valid launch receipt; the request is unconfirmed and will not be retried.")
    if not isinstance(native, dict):
        raise LaunchError("Android returned an invalid launch receipt; the request is unconfirmed and will not be retried.")
    fields = ("action", "uid", "user_id", "sdk", "calling_package", "package_attribution_verified",
              "wait_result_received", "raw_start_result", "classification", "wait_timed_out",
              "reported_component", "reported_total_time_ms", "binder_call_timed_out",
              "activity_request_entered", "maximum_activity_requests", "no_retry", "error_class")
    # Do not duplicate the potentially2048-character URL in the bounded worker receipt.
    report["android_start"] = {key: native[key] for key in fields if key in native}
    valid = (native.get("kind") == "cluster-android-start-result" and native.get("action") == action
             and type(native.get("uid")) is int and native["uid"] == uid
             and type(native.get("user_id")) is int and native["user_id"] == uid // 100000
             and type(native.get("sdk")) is int and native["sdk"] == 35
             and native.get("calling_package") == "com.termux" and native.get("package_attribution_verified") is True
             and native.get("caller_thread_is_null") is True and native.get("options_are_null") is True
             and type(native.get("maximum_activity_requests")) is int
             and native["maximum_activity_requests"] == 1 and native.get("no_retry") is True
             and native.get("permissions_changed") is False and native.get("settings_changed") is False
             and native.get("identity_changed") is False and native.get("visible_screen_verified") is False
             and native.get("activity_request_entered") is True
             and (native.get("url") == report["url"] if action == "open-website" else "url" not in native))
    raw = native.get("raw_start_result")
    if valid and type(raw) is int and raw == 102:
        report["error_code"] = "android-background-launch-blocked"
        report["error"] = "Android blocked this background activity launch (START_ABORTED102). No retry was sent."
        return report
    component = native.get("reported_component")
    accepted = {0: "START_SUCCESS", 2: "START_TASK_TO_FRONT", 3: "START_DELIVERED_TO_TOP"}
    if (not valid or completed.returncode != 0 or type(raw) is not int or raw not in accepted
            or native.get("classification") != accepted[raw] or native.get("wait_result_received") is not True
            or native.get("wait_timed_out") is not False or native.get("binder_call_timed_out")
            or native.get("error_class") or not isinstance(component, str)
            or not re.fullmatch(r"[A-Za-z0-9_.$]+/[A-Za-z0-9_.$]+", component) or len(component) > 180
            or action == "return-termux" and component not in {"com.termux/.app.TermuxActivity", "com.termux/com.termux.app.TermuxActivity"}):
        raise LaunchError("Android did not return a verified activity-launch receipt; outcome is unconfirmed and will not be retried.")
    if action == "return-termux":
        report["return_requested"] = True
        visibility = native.get("termux_visibility")
        if isinstance(visibility, dict):
            report["termux_visibility"] = {key: visibility[key] for key in (
                "query_succeeded", "task_snapshot_complete", "focused_visible_termux_task_count", "query_timed_out", "visibility_samples") if key in visibility}
        count = visibility.get("focused_visible_termux_task_count") if isinstance(visibility, dict) else None
        known = (isinstance(visibility, dict) and visibility.get("query_succeeded") is True
                 and visibility.get("task_snapshot_complete") is True
                 and visibility.get("query_timed_out", False) is False
                 and type(count) is int and 0 <= count <= 16)
        if not known:
            report["error_code"] = "android-return-unconfirmed"
            report["error"] = "Android received the Termux request, but its foreground state could not be verified. No retry was sent."
        elif count == 0:
            report["error_code"] = "android-termux-not-foreground"
            report["error"] = "Android received the Termux request, but Termux is not the focused visible activity. No retry was sent."
        else:
            report["state"] = "termux-foreground"
            report["foreground_app_verified"] = True
        return report
    report["state"] = "launch-requested"
    report["launch_requested"] = True
    return report


def open_browser(url, environ=None, current_platform=None, run=None, which=None, uid=None,
                 proc_reader=None, session_checker=None, popen=None, native_prepare=None):
    environ = dict(os.environ if environ is None else environ)
    run = subprocess.run if run is None else run
    popen = subprocess.Popen if popen is None else popen
    which = shutil.which if which is None else which
    platform = platform_name(environ, current_platform)
    report = {
        "kind": "website-browser-open", "url": compact_text(url, MAX_URL_LENGTH),
        "platform": platform, "state": "failed", "launch_requested": False,
        "visible_screen_verified": False, "launcher": None,
        "opener_completed": False,
        "scope": "Existing browser navigation request only; page rendering and physical screen are unverified.",
        "error": None,
    }
    try:
        report["url"] = validate_url(url)
        command_env = dict(environ)
        if platform == "android":
            return android_request(report, "open-website", environ, run, uid, native_prepare)
        elif platform == "linux":
            uid = os.getuid() if uid is None else uid
            desktop = find_graphical_environment(environ, uid, proc_reader, session_checker)
            # Remove stale SSH display variables before adding the actual session.
            for key in DESKTOP_KEYS:
                command_env.pop(key, None)
            command_env.update(desktop)
            launcher = which("gio", path=environ.get("PATH"))
            if launcher:
                command = [launcher, "open", report["url"]]
            else:
                launcher = which("xdg-open", path=environ.get("PATH"))
                if not launcher:
                    raise LaunchError("No existing xdg-open or gio browser opener is available.")
                command = [launcher, report["url"]]
        else:
            raise LaunchError("This helper supports Android Termux and Linux desktop sessions only.")
        report["launcher"] = launcher
        if platform == "linux":
            # Openers may become or spawn a long-lived browser. Captured pipes
            # can keep communicate() hanging after an opener timeout. Detach
            # all streams and observe briefly, leaving every browser intact.
            process = popen(command, env=command_env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            shell=False, start_new_session=True, close_fds=True)
            try:
                code = process.wait(timeout=DESKTOP_OBSERVATION_SECONDS)
            except subprocess.TimeoutExpired:
                code = None
            if code is not None and code != 0:
                raise LaunchError("Browser opener failed (exit " + str(code) + ").")
            report["opener_completed"] = code == 0
            report["state"] = "launch-requested"
            report["launch_requested"] = True
            return report
    except subprocess.TimeoutExpired:
        report["error"] = "Android launch receipt timed out; outcome is unconfirmed. No retry was sent."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    if platform == "android":
        report.setdefault("error_code", "android-launch-unconfirmed")
    return report


def return_termux(environ=None, current_platform=None, run=None, which=None, uid=None, native_prepare=None):
    """Request the fixed existing Termux activity once, without closing a browser."""
    environ = dict(os.environ if environ is None else environ)
    run = subprocess.run if run is None else run
    which = shutil.which if which is None else which
    platform = platform_name(environ, current_platform)
    report = {
        "kind": "phone-termux-return", "platform": platform, "state": "failed",
        "return_requested": False, "request_completed": False,
        "foreground_app_verified": False,
        "visible_screen_verified": False, "launcher": None,
        "scope": "One existing Termux activity request with an own-task focus and visibility check; physical screen is unverified. Browser is not closed.",
        "error": None,
    }
    try:
        if platform != "android":
            raise LaunchError("Return to Termux is available only on Android Termux phones; desktop browsers are not changed.")
        return android_request(report, "return-termux", environ, run, uid, native_prepare)
    except subprocess.TimeoutExpired:
        report["error"] = "Android return receipt timed out; outcome is unconfirmed. No retry was sent."
    except (LaunchError, OSError, ValueError) as exc:
        report["error"] = compact_text(exc) or type(exc).__name__
    if platform == "android":
        report.setdefault("error_code", "android-launch-unconfirmed")
    return report


def main():
    parser = argparse.ArgumentParser(description="Request one browser navigation or Termux return; no screen verification.")
    parser.add_argument("--settings-b64", required=True)
    args = parser.parse_args()
    try:
        if len(args.settings_b64) > 16384:
            raise ValueError("Settings are too large")
        settings = json.loads(base64.b64decode(args.settings_b64, validate=True).decode("utf-8"))
        if isinstance(settings, dict) and set(settings) == {"url"} and isinstance(settings["url"], str):
            report = open_browser(settings["url"])
        elif isinstance(settings, dict) and set(settings) == {"action"} and settings["action"] == "return-termux":
            report = return_termux()
        else:
            raise ValueError("Settings must contain only a URL string or the fixed return-termux action")
    except (ValueError, UnicodeError):
        report = open_browser("")
        report["error"] = "Invalid encoded URL settings."
    print(json.dumps(report, ensure_ascii=True, separators=(",", ":")))
    if report.get("kind") == "phone-termux-return":
        return 0 if report.get("state") == "termux-foreground" and report.get("foreground_app_verified") is True else 1
    return 0 if report.get("launch_requested") else 1


if __name__ == "__main__":
    raise SystemExit(main())
