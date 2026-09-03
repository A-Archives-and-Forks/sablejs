function f(){var x=1,y=x;try{x=2;throw 0;}finally{return x;}}f();
