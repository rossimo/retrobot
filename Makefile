CXX = em++
CXXFLAGS += --bind \
	-s WASM=1 -s LINKABLE=1 -s EXPORT_ALL=1 -s MODULARIZE=1 -O3 \
	-sLLD_REPORT_UNDEFINED -sALLOW_MEMORY_GROWTH \
	-lstdc++ \
	--no-entry

all: mgba_libretro.js quicknes_libretro.js snes9x2010_libretro.js

mgba_libretro.js: src/mgba_libretro_emscripten.bc
	$(CXX) src/bindings.cxx src/mgba_libretro_emscripten.bc $(CXXFLAGS) -o cores/mgba_libretro.js

quicknes_libretro.js: src/quicknes_libretro_emscripten.bc
	$(CXX) src/bindings.cxx src/quicknes_libretro_emscripten.bc $(CXXFLAGS) -o cores/quicknes_libretro.js

snes9x2010_libretro.js: src/snes9x2010_libretro_emscripten.bc
	$(CXX) src/bindings.cxx src/snes9x2010_libretro_emscripten.bc $(CXXFLAGS) -o cores/snes9x2010_libretro.js