FROM sbtscala/scala-sbt:eclipse-temurin-21.0.5_11_1.10.7_3.6.2

USER root
RUN mkdir -p /opt/scala-deps/src/main/scala \
    && printf '%s\n' \
      'ThisBuild / version := "0.1.0"' \
      'ThisBuild / scalaVersion := "3.6.2"' \
      'lazy val root = (project in file(".")).settings(name := "compiler-deps")' \
      > /opt/scala-deps/build.sbt \
    && printf 'object Main extends App { println("deps") }\n' > /opt/scala-deps/src/main/scala/Main.scala \
    && cd /opt/scala-deps \
    && sbt 'libraryDependencies ++= Seq("com.typesafe.akka" %% "akka-actor-typed" % "2.9.3", "org.typelevel" %% "cats-core" % "2.12.0", "com.typesafe.play" %% "play-json" % "3.0.4")' update compile || true

RUN useradd -m compiler
USER compiler
WORKDIR /workspace

CMD ["scala", "-version"]
