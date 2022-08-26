#include <emscripten/bind.h>
#include <iostream>

extern "C"
{
#include "libretro.h"
}

void simple_retro_get_system_info(emscripten::val obj)
{
    struct retro_system_info info = {0};
    retro_get_system_info(&info);

    obj.set("library_name", info.library_name);
    obj.set("library_version", info.library_version);
    obj.set("valid_extensions", info.valid_extensions);
    obj.set("need_fullpath", info.need_fullpath);
    obj.set("block_extract", info.block_extract);
}

void simple_retro_get_system_av_info(emscripten::val obj)
{
    struct retro_system_av_info info = {0};
    retro_get_system_av_info(&info);

    obj.set("geometry_base_width", info.geometry.base_width);
    obj.set("geometry_base_height", info.geometry.base_height);
    obj.set("geometry_max_width", info.geometry.max_width);
    obj.set("geometry_max_height", info.geometry.max_height);
    obj.set("geometry_aspect_ratio", info.geometry.aspect_ratio);

    obj.set("timing_fps", info.timing.fps);
    obj.set("timing_sample_rate", info.timing.sample_rate);
}

bool simple_retro_serialize(emscripten::val dataVal, emscripten::val sizeVal)
{
    void *data = (void *)dataVal.as<unsigned int>();
    size_t size = sizeVal.as<unsigned int>();

    return retro_serialize(data, size);
}

bool simple_retro_unserialize(emscripten::val dataVal, emscripten::val sizeVal)
{
    void *data = (void *)dataVal.as<unsigned int>();
    size_t size = sizeVal.as<unsigned int>();

    return retro_unserialize(data, size);
}

emscripten::val retro_environment_callback = emscripten::val::undefined();

bool inner_retro_environment(unsigned cmd, void *data)
{
    if (retro_environment_callback != emscripten::val::undefined())
    {
        return retro_environment_callback(cmd, (unsigned int)data).as<unsigned int>();
    }

    return false;
}

void simple_retro_set_environment(emscripten::val val)
{
    retro_environment_callback = val;

    retro_set_environment(&inner_retro_environment);
}

emscripten::val retro_video_refresh_callback = emscripten::val::undefined();

void inner_retro_set_video_refresh(const void *data, unsigned width, unsigned height, size_t pitch)
{
    if (retro_video_refresh_callback != emscripten::val::undefined())
    {
        retro_video_refresh_callback((unsigned int)data, (unsigned int)width, (unsigned int)height, (unsigned int)pitch);
    }
}

void simple_retro_set_video_refresh(emscripten::val val)
{
    retro_video_refresh_callback = val;
}

void inner_retro_set_input_poll()
{
}

emscripten::val retro_set_input_state_callback = emscripten::val::undefined();

void simple_retro_set_input_state(emscripten::val val)
{
    retro_set_input_state_callback = val;
}

int16_t inner_retro_set_input_state(unsigned port, unsigned device, unsigned index, unsigned id)
{
    if (retro_set_input_state_callback != emscripten::val::undefined())
    {
        retro_set_input_state_callback((unsigned int)port, (unsigned int)device, (unsigned int)index, (unsigned int)id);
    }

    return 0;
}

void inner_retro_set_audio_sample(int16_t left, int16_t right)
{
}

size_t inner_retro_set_audio_sample_batch(const int16_t *data, size_t frames)
{
    return 0;
}

bool simple_retro_load_game(emscripten::val val)
{
    retro_set_video_refresh(&inner_retro_set_video_refresh);
    retro_set_input_poll(&inner_retro_set_input_poll);
    retro_set_input_state(&inner_retro_set_input_state);
    retro_set_audio_sample(&inner_retro_set_audio_sample);
    retro_set_audio_sample_batch(&inner_retro_set_audio_sample_batch);
    retro_init();

    retro_game_info info;
    info.data = (const char *)val["data"].as<unsigned int>();
    info.size = val["size"].as<int>();

    return retro_load_game(&info);
}

EMSCRIPTEN_BINDINGS(libretro_bindings)
{
    emscripten::function("retro_get_system_info", &simple_retro_get_system_info);
    emscripten::function("retro_get_system_av_info", &simple_retro_get_system_av_info);
    emscripten::function("retro_set_environment", &simple_retro_set_environment);
    emscripten::function("retro_load_game", &simple_retro_load_game);
    emscripten::function("retro_set_video_refresh", &simple_retro_set_video_refresh);
    emscripten::function("retro_run", &retro_run);
    emscripten::function("retro_init", &retro_init);
    emscripten::function("retro_reset", &retro_reset);
    emscripten::function("retro_serialize_size", &retro_serialize_size);
    emscripten::function("retro_serialize", &simple_retro_serialize);
    emscripten::function("retro_unserialize", &simple_retro_unserialize);
    emscripten::function("retro_set_input_state", &simple_retro_set_input_state);
    emscripten::function("retro_unload_game", &retro_unload_game);
}