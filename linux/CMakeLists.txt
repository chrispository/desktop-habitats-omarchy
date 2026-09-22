cmake_minimum_required(VERSION 3.21)
project(desktop-habitats LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets WebEngineCore WebEngineWidgets)
find_package(LayerShellQt REQUIRED)

add_executable(desktop-habitats src/main.cpp)
target_link_libraries(desktop-habitats PRIVATE
  Qt6::Core Qt6::Gui Qt6::Widgets Qt6::WebEngineCore Qt6::WebEngineWidgets
  LayerShellQt::Interface)
