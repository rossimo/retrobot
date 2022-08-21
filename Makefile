CXX = em++
CXXFLAGS += --bind \
	-s WASM=1 -s LINKABLE=1 -s EXPORT_ALL=1 -s MODULARIZE=1 \
	-sLLD_REPORT_UNDEFINED -sALLOW_MEMORY_GROWTH \
	-lnodefs.js -lstdc++ \
	--no-entry

all: gambatte_libretro.js

gambatte_libretro.js: src/gambatte_libretro_emscripten.bc
	$(CXX) src/bindings.cxx src/gambatte_libretro_emscripten.bc $(CXXFLAGS) -o cores/gambatte_libretro.js

fceumm_libretro.js: src/fceumm_libretro_emscripten.bc
	$(CXX) src/bindings.cxx src/fceumm_libretro_emscripten.bc $(CXXFLAGS) -o cores/fceumm_libretro.js